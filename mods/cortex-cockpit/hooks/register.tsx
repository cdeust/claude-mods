import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CortexEntry, CortexStats, HygieneSnapshot, StageTally, TurnTally } from '../types'
import { placePath } from './paths'
import type { ContextHealth, GeniusState, PolicyState, Refusal } from './deps'
import { OWNERSHIP_PATH, type Ownership, parseOwnership, psRefusal, testProcesses, worktrees } from './hygiene'
import { type Machine, runChecks } from './machinecheck'
import { begin, emptyTally, finish, group, isCortexTool, parseStats, shortTool } from './model'
import { bump, emptyStages, stageOf } from './pipeline'
import { inputGist, outputText, parseRecall } from './recall'
import { RecallResultView, UseRowView } from './rows'
import { type Surface, tone } from './tokens'
import { Cockpit } from './view'

const PANE = 'cortex-cockpit'
const LEDGER_CAP = 200 // source: bounds $.state size; the pane shows the last rows only
const SLOW_MS = 2000 // source: memory_stats states ~75 ms; a call ten times slower is worth a word
const RETRY_MS = [2000, 5000, 15000] // source: own choice, MCP servers connect after the mod loads

const ledger = atom({ plugin: 'cortex-cockpit', key: 'ledger' } as const, [] as CortexEntry[])
const stats = atom({ plugin: 'cortex-cockpit', key: 'stats' } as const, null as CortexStats | null)
const statsError = atom({ plugin: 'cortex-cockpit', key: 'statsError' } as const, null as string | null)
const tally = atom({ plugin: 'cortex-cockpit', key: 'tally' } as const, emptyTally())
const stages = atom({ plugin: 'cortex-cockpit', key: 'stages' } as const, emptyStages() as Record<string, StageTally>)
const hygiene = atom({ plugin: 'cortex-cockpit', key: 'hygiene' } as const, null as HygieneSnapshot | null)

// Tools after which the memory population changes, so the headline numbers are re-read.
// source: Cortex handlers that write (mcp_server/handlers/*: remember, forget, consolidate, ...).
const MUTATING = new Set(['remember', 'forget', 'consolidate', 'checkpoint', 'import_sessions'])

const surfaceOf = (value: unknown): Surface => (value === 'paper' ? 'paper' : 'ink')

// Module state the readers share: where the repo is and which Cortex server to call.
let repo = ''
let server = 'plugin_hypermnesia-mcp_cortex'

// Where a `~/` path lands on this machine: HOME, else USERPROFILE, and CLAUDE_CONFIG_DIR for what lives
// in the engine's config directory (paths.ts). No home to place it is an error with that reason.
async function expandHome($: EngineInterface, path: string): Promise<string> {
  if (!path.startsWith('~/')) return path
  const placed = placePath(
    { home: await $.env.get('HOME'), userProfile: await $.env.get('USERPROFILE'), configDir: await $.env.get('CLAUDE_CONFIG_DIR') },
    path,
  )
  if ('reason' in placed) throw new Error(placed.reason)

  return placed.path
}

// The other mods' state, as their contracts declare it (plugin.json `dependencies`); a mod not
// loaded reads as undefined. The references are literals here, as the validator lists them.
const GUARD_REFUSALS = { plugin: 'cortex-guard', key: 'refusals' } as const
const AUTOPILOT_CONTEXT = { plugin: 'zetetic-autopilot', key: 'context' } as const
const AUTOPILOT_POLICY = { plugin: 'zetetic-autopilot', key: 'policy' } as const
const GENIUS_STATE = { plugin: 'zetetic-genius', key: 'state' } as const

async function peekRefusals($: EngineInterface): Promise<readonly Refusal[]> {
  try {
    return (await $.state.get(GUARD_REFUSALS)).value ?? []
  } catch {
    return []
  }
}

async function peekContext($: EngineInterface): Promise<ContextHealth | null> {
  try {
    return (await $.state.get(AUTOPILOT_CONTEXT)).value ?? null
  } catch {
    return null
  }
}

async function peekPolicy($: EngineInterface): Promise<PolicyState | null> {
  try {
    return (await $.state.get(AUTOPILOT_POLICY)).value ?? null
  } catch {
    return null
  }
}

async function peekGenius($: EngineInterface): Promise<GeniusState | null> {
  try {
    return (await $.state.get(GENIUS_STATE)).value ?? null
  } catch {
    return null
  }
}

// memory_stats is read-only and takes no arguments (handlers/memory_stats.py, schema). A server
// not yet connected answers with an error; the read re-arms itself a few times.
async function refreshStats($: EngineInterface, attempt = 0): Promise<void> {
  let parsed: ReturnType<typeof parseStats>
  try {
    parsed = parseStats(await $.mcp.call(server, 'memory_stats'), await $.clock.now())
  } catch (error) {
    parsed = { error: `${server} unreachable: ${String(error).slice(0, 140)}` }
  }
  if ('stats' in parsed) {
    await update($, stats, () => parsed.stats)
    await update($, statsError, () => null)
    return
  }
  await update($, statsError, () => parsed.error)
  const wait = RETRY_MS[attempt]
  if (wait !== undefined) $.clock.after(wait, () => refreshStats($, attempt + 1))
}

// The worktree registry disk_hygiene.py keeps. A file that is not there is an empty registry (nothing
// was ever registered); a file that is there and cannot be read, or is not the object it writes, is
// an error carrying the reason.
async function readRegistry($: EngineInterface): Promise<{ ownership: Ownership | undefined; error: string | null }> {
  try {
    const path = await expandHome($, OWNERSHIP_PATH)
    if (!(await $.fs.exists(path))) return { ownership: undefined, error: null }

    return { ownership: parseOwnership(await $.fs.read(path)), error: null }
  } catch (error) {
    return { ownership: undefined, error: cut(error) }
  }
}

// The test runners among the running processes; a ps that cannot start or exits non-zero is an
// error carrying the reason (Windows has no ps), never "no test runner running".
async function readProcesses($: EngineInterface): Promise<{ rows: HygieneSnapshot['testProcesses']; error: string | null }> {
  try {
    const ps = await $.process.run(['ps', '-eo', 'pid,etime,command'])
    const refusal = psRefusal(ps)

    return refusal === null ? { rows: testProcesses(ps.stdout), error: null } : { rows: [], error: refusal }
  } catch (error) {
    return { rows: [], error: `ps could not run: ${cut(error)}` }
  }
}

const cut = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 120)

async function refreshHygiene($: EngineInterface): Promise<void> {
  const readAt = await $.clock.now()
  let snapshot: HygieneSnapshot
  try {
    const list = await $.process.run(['git', 'worktree', 'list', '--porcelain'], { cwd: repo })
    if (list.exitCode !== 0) {
      snapshot = { worktrees: [], testProcesses: [], processesError: null, ownershipError: null, error: list.stderr.slice(0, 120), readAt }
    } else {
      const registry = await readRegistry($)
      const procs = await readProcesses($)
      snapshot = {
        worktrees: worktrees(list.stdout, registry.ownership),
        testProcesses: procs.rows,
        processesError: procs.error,
        ownershipError: registry.error,
        error: null,
        readAt,
      }
    }
  } catch (error) {
    snapshot = { worktrees: [], testProcesses: [], processesError: null, ownershipError: null, error: cut(error), readAt }
  }
  await update($, hygiene, () => snapshot)
}

// What /cortex check may read: each read is spelled here, where the engine follows `$`. One
// state key per mod this mod depends on, as its contract declares it.
const machineOf = ($: EngineInterface): Machine => ({
  vars: async () => ({
    home: await $.env.get('HOME'),
    userProfile: await $.env.get('USERPROFILE'),
    configDir: await $.env.get('CLAUDE_CONFIG_DIR'),
  }),
  config: () => $.config.list(),
  commands: async () => (await $.command.list()).map((c) => ({ name: c.name, source: c.source, plugin: c.plugin })),
  state: async (mod) => {
    if (mod === 'cortex-guard') return (await $.state.get({ plugin: 'cortex-guard', key: 'refusals' })).value
    if (mod === 'zetetic-genius') return (await $.state.get({ plugin: 'zetetic-genius', key: 'state' })).value

    return (await $.state.get({ plugin: 'zetetic-autopilot', key: 'policy' })).value
  },
  run: (argv, timeoutMs) => $.process.run(argv, timeoutMs === undefined ? undefined : { timeoutMs }),
  stat: (path) => $.fs.stat(path),
  read: (path) => $.fs.read(path),
  memoryStats: (name) => $.mcp.call(name, 'memory_stats'),
  now: () => $.clock.now(),
})

async function consolidateNow($: EngineInterface): Promise<void> {
  $.ui.toast('consolidate: running')
  try {
    await $.mcp.call(server, 'consolidate')
  } finally {
    void refreshStats($)
  }
}

export const register: Register = (on, options) => {
  server = String(options.cortex_server ?? server)
  const surface = surfaceOf(options.surface)

  on('session.start', async ($, e, next) => {
    repo = (await $.session.repo())?.root ?? e.cwd
    void refreshStats($)
    void refreshHygiene($)
    try {
      await $.command.register({ name: 'cortex', description: 'Open the Cortex cockpit pane; /cortex check tests what the six mods need of this machine', argumentHint: 'check', immediate: true })
    } catch (error) {
      $.ui.toast(`/cortex is taken by another plugin: ${String(error).slice(0, 80)}`)
    }

    return next(e)
  })

  on('command.run', { command: 'cortex' }, async ($, e) => {
    if ((e.args ?? '').trim() === 'check') return { text: await runChecks(machineOf($), { server, surface: String(options.surface ?? 'ink') }) }
    await $.ui.open({ id: PANE, title: 'Cortex' })
    void refreshStats($)
    void refreshHygiene($)

    return { text: 'Cortex cockpit opened.' }
  })

  // Observer: tallies every tool, places it on the pipeline, and keeps the Cortex ledger.
  on('tool.call', async ($, e, next) => {
    const name = String(e.tool)
    const short = shortTool(name)
    const stage = stageOf(name, e as { command?: string })
    await update($, tally, (t: TurnTally) => ({ ...t, tools: { ...t.tools, [short]: (t.tools[short] ?? 0) + 1 } }))
    const entry =
      isCortexTool(name) && e.tool_use_id !== undefined ? begin(e.tool_use_id, name, await $.clock.now()) : undefined
    if (entry !== undefined) await update($, ledger, (list) => [...list, entry].slice(-LEDGER_CAP))

    const ran = await next(e)
    const now = await $.clock.now()
    const isBlocked = ran.deny !== undefined || ran.isError === true
    if (stage !== undefined) await update($, stages, (s) => bump(s, stage, name, now, isBlocked))
    if (entry !== undefined) {
      const done = finish(entry, now, ran.text ?? '', isBlocked)
      await update($, ledger, (list) => list.map((one) => (one.id === entry.id ? done : one)))
      if ((done.ms ?? 0) >= SLOW_MS) $.ui.status(`cortex ${short} slow: ${group(done.ms ?? 0)} ms`)
      if (MUTATING.has(short)) void refreshStats($)
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    if (u !== undefined && e.agentId === undefined) {
      await update($, tally, (t: TurnTally) => ({
        ...t,
        turns: t.turns + 1,
        input: t.input + u.input_tokens,
        output: t.output + u.output_tokens,
        cacheRead: t.cacheRead + u.cache_read_input_tokens,
        cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
      }))
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    Cockpit($.ui.resolve(e) as never, {
      surface,
      now: await $.clock.now(),
      columns: e.props.bodyColumns,
      repo,
      stats: await read($, stats),
      statsError: await read($, statsError),
      ledger: await read($, ledger),
      tally: await read($, tally),
      stages: await read($, stages),
      hygiene: await read($, hygiene),
      context: await peekContext($),
      policy: await peekPolicy($),
      genius: await peekGenius($),
      refusals: await peekRefusals($),
      onRefresh: () => {
        void refreshStats($)
        void refreshHygiene($)
      },
      onConsolidate: () => void consolidateNow($),
      onCurateWiki: () =>
        void $.prompt.submit({ text: 'Call curate_wiki, then write each authoring job it returns with wiki_write.' }),
    }),
  )

  // Transcript rows, Cortex tools only; everything else is the engine's own row.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!isCortexTool(e.props.tool)) return next(e)
    const entry = (await read($, ledger)).find((one) => one.id === e.props.tool_use_id)

    return UseRowView($.ui.resolve(e) as never, {
      surface,
      tool: shortTool(e.props.tool),
      gist: inputGist(e.props.input),
      isRunning: e.props.isRunning,
      isErrored: e.props.isErrored,
      entry,
    })
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!isCortexTool(e.props.tool) || e.props.isErrored) return next(e)
    const view = parseRecall(outputText(e.props.output))
    if (view === undefined) return next(e)

    return RecallResultView($.ui.resolve(e) as never, shortTool(e.props.tool), view)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, stats)
    const failure = await read($, statsError)
    const c = await peekContext($)
    if (e.props.hasSurvey || (s === null && failure === null && c === null)) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const refused = (await peekRefusals($)).length
    const pressure = (await peekPolicy($))?.pressure ?? 'none'
    const calls = (await read($, ledger)).length
    const ctx = c === null || c.percent === null ? 'ctx: no reading' : `ctx ${c.percent} %`
    const mem = s === null ? 'stats blocked' : `${group(s.total_memories)} memories`

    return (
      <Box>
        <Text color={s === null ? tone(surface, 'danger') : undefined} dimColor={s !== null}>
          cortex · {ctx} · {mem} · {group(calls)} calls · {refused === 0 ? 'nothing refused' : `${group(refused)} refused`}
          {pressure === 'none' ? '' : ` · pressure ${pressure}`}{' '}
        </Text>
        <Button key="open" label="Cockpit" onPress={() => void $.ui.open({ id: PANE, title: 'Cortex' })} />
      </Box>
    )
  })
}
