// /cortex check: what the six mods need of the machine they run on, tested one thing at a time.
// A line is `ok`, `FAIL` or `n/a`; a refusal from the machine (a sandbox, a missing binary, an
// MCP server that is not connected) reaches the line as the first 160 characters of its own
// text, so the owner can paste it back. Every check only reads: nothing outward, nothing
// written, apart from the answer.
//
// The engine follows `$` only inside the module that spells it (and a plugin has one module), so
// this file never sees `$`: register.tsx hands it a `Machine`, the reads it may make, each one
// a call spelled in that file.

import {
  type CheckLine,
  type ConfigRow,
  GUARD_DEFAULT_SCRIPT,
  MODS,
  type Own,
  checkModels,
  checkOptions,
  cut,
  firstLine,
  line,
  renderLines,
  why,
} from './checkfmt'
import { checkFleetRecords, checkGhAuth, checkPs } from './fleetcheck'
import { parseStats } from './model'
import { type PathVars, placePath } from './paths'
import { PYTHON_CANDIDATES } from './rules'

const GH_TIMEOUT_MS = 15_000 // source: own choice, a sandbox that drops packets must answer a line, not hang the command

type Ran = { exitCode: number; stdout: string; stderr: string }
type McpResult = { content: readonly { type: string; text?: string }[]; isError: boolean; structuredContent?: unknown }

// One slash command as the engine lists it: its name, where it comes from (`builtin`, `plugin`,
// `user`, `mcp`) and, for a plugin's, the name of the plugin that registered it (absent when the
// engine does not know).
export type CommandRow = { name: string; source: string; plugin?: string }

export type Machine = {
  // HOME, USERPROFILE and CLAUDE_CONFIG_DIR as the engine reports them; paths.ts places `~/` from them.
  vars: () => Promise<PathVars>
  config: () => Promise<readonly ConfigRow[]>
  commands: () => Promise<readonly CommandRow[]>
  // The value under one mod's declared state key; `undefined` when never written. Rejects when
  // the mod is not loaded.
  state: (mod: 'cortex-guard' | 'zetetic-genius' | 'zetetic-autopilot') => Promise<unknown>
  run: (argv: string[], timeoutMs?: number) => Promise<Ran>
  stat: (path: string) => Promise<{ kind: string }>
  read: (path: string) => Promise<string>
  memoryStats: (server: string) => Promise<McpResult>
  now: () => Promise<number>
}

async function configRows(m: Machine): Promise<{ rows: readonly ConfigRow[] } | { error: string }> {
  try {
    return { rows: await m.config() }
  } catch (error) {
    return { error: why(error) }
  }
}

// Which mods answer. cortex-guard, zetetic-genius and zetetic-autopilot are dependencies of this
// mod, and the engine leaves a mod disabled when a dependency is missing, so they are loaded
// whenever this check runs; their state is read for what it says. cortex-wiki and harness-fleet
// are loaded when the command they register is in the engine's list AND the plugin that registered
// it is that mod: a user's own `wiki.md`, an MCP prompt or another plugin's command of the same
// name says nothing about the mod. A directory-loaded mod reports its bare manifest name in
// `plugin` (measured: `--plugin-dir` gives "cortex-wiki" and "harness-fleet"); a `name@source` id
// of the same name is read as the same plugin. A state key that was never
// written reads `undefined` for a loaded mod and for an absent one alike, so it proves nothing
// about loading.
const DEPENDENCIES = ['cortex-guard', 'zetetic-genius', 'zetetic-autopilot'] as const
type Dependency = (typeof DEPENDENCIES)[number]
const isDependency = (mod: string): mod is Dependency => (DEPENDENCIES as readonly string[]).includes(mod)
const COMMAND_OF: Readonly<Record<string, string>> = { 'cortex-wiki': 'wiki', 'harness-fleet': 'fleet' }

// The line for a mod known by the command it registers.
function checkRegistered(mod: string, command: string, commands: readonly CommandRow[], commandsError: string): CheckLine {
  const named = commands.filter((c) => c.name === command)
  const own = named.find((c) => c.source === 'plugin' && c.plugin !== undefined && (c.plugin === mod || c.plugin.startsWith(`${mod}@`)))
  if (own !== undefined) return line('ok', `mod ${mod}`, `loaded, /${command} is registered by plugin ${own.plugin}`)
  if (named.length === 0) return line('FAIL', `mod ${mod}`, `not loaded: /${command} is not registered${commandsError}`)
  const unknown = named.find((c) => c.source === 'plugin' && c.plugin === undefined)
  if (unknown !== undefined) return line('n/a', `mod ${mod}`, `/${command} is a plugin's command but the engine does not say which plugin, so loading is not proven`)
  const who = named.map((c) => (c.source === 'plugin' ? `plugin ${c.plugin}` : c.source)).join(', ')

  return line('FAIL', `mod ${mod}`, `not loaded: /${command} exists but is registered by ${who}, not by ${mod}`)
}

async function checkMods(m: Machine): Promise<{ lines: CheckLine[]; states: Record<string, unknown> }> {
  let commands: readonly CommandRow[] = []
  let commandsError = ''
  try {
    commands = await m.commands()
  } catch (error) {
    commandsError = ` (the command list was refused: ${why(error)})`
  }
  const lines: CheckLine[] = []
  const states: Record<string, unknown> = {}
  for (const mod of MODS) {
    const command = COMMAND_OF[mod]
    if (command !== undefined) {
      lines.push(checkRegistered(mod, command, commands, commandsError))
    } else if (mod === 'cortex-cockpit') {
      lines.push(line('ok', `mod ${mod}`, 'loaded, this check runs in it'))
    } else if (isDependency(mod)) {
      try {
        states[mod] = await m.state(mod)
        lines.push(line('ok', `mod ${mod}`, `loaded (a dependency of this mod), ${states[mod] === undefined ? 'state key not written yet' : 'state key readable'}`))
      } catch (error) {
        lines.push(line('FAIL', `mod ${mod}`, `state key unreadable: ${why(error)}`))
      }
    }
  }
  return { lines, states }
}

async function checkCommand(m: Machine, name: string, argv: string[]): Promise<CheckLine> {
  try {
    const ran = await m.run(argv)
    if (ran.exitCode !== 0) return line('FAIL', name, `exit ${ran.exitCode}: ${firstLine(ran.stderr) || firstLine(ran.stdout) || 'no output'}`)

    return line('ok', name, firstLine(ran.stdout) || firstLine(ran.stderr) || 'exit 0')
  } catch (error) {
    return line('FAIL', name, `${argv.join(' ')} could not start: ${why(error)}`)
  }
}

async function checkHygiene(m: Machine, rows: readonly ConfigRow[] | undefined): Promise<CheckLine> {
  const name = 'hygiene script (cortex-guard)'
  const set = rows?.find((row) => row.key === 'cortex-guard.hygiene_script')?.value
  const option = typeof set === 'string' ? set : GUARD_DEFAULT_SCRIPT
  const basis = typeof set === 'string' ? '' : ' (option not readable here, so its default location is checked)'
  if (option === '') return line('n/a', name, 'option is empty: worktree registration is disabled on purpose')
  const placed = placePath(await m.vars(), option)
  if ('reason' in placed) return line('FAIL', name, `cannot place ${option}: ${placed.reason}`)
  const path = placed.path
  try {
    const stat = await m.stat(path)
    return stat.kind === 'file' ? line('ok', name, `${path} exists${basis}`) : line('FAIL', name, `${path} is not a file (${stat.kind})${basis}`)
  } catch (error) {
    return line('FAIL', name, `not found at ${path}: ${why(error)}${basis}`)
  }
}

async function checkCortex(m: Machine, server: string): Promise<CheckLine> {
  const name = `Cortex MCP server ${server}`
  try {
    const parsed = parseStats(await m.memoryStats(server), await m.now())

    return 'stats' in parsed
      ? line('ok', name, `memory_stats answers, ${parsed.stats.total_memories} memories`)
      : line('FAIL', name, `memory_stats: ${cut(parsed.error)}`)
  } catch (error) {
    return line('FAIL', name, `memory_stats call refused: ${why(error)}`)
  }
}

async function checkRateLimit(m: Machine): Promise<CheckLine> {
  const name = 'gh api rate_limit'
  try {
    const ran = await m.run(['gh', 'api', 'rate_limit'], GH_TIMEOUT_MS)
    if (ran.exitCode !== 0) return line('FAIL', name, `exit ${ran.exitCode}: ${firstLine(ran.stderr) || firstLine(ran.stdout) || 'no output'}`)
    try {
      const core = (JSON.parse(ran.stdout) as { resources: { core: { remaining: number; limit: number } } }).resources.core

      return line('ok', name, `api.github.com answers, core ${core.remaining}/${core.limit} left`)
    } catch {
      // Exit 0 with anything but the rate_limit document proves no reach to the API: a proxy's page, an empty body.
      return line('FAIL', name, `exit 0 but the answer is not the rate_limit JSON: ${firstLine(ran.stdout) || 'empty output'}`)
    }
  } catch (error) {
    return line('FAIL', name, `could not run: ${why(error)}`)
  }
}

// The python cortex-guard runs the hygiene script with: the first of PYTHON_CANDIDATES that starts and
// exits 0 on --version (the order the mod tries them in). One that exits non-zero or cannot start is
// reported beside the one that answered; none answering is a failure, never a pass.
async function checkPython(m: Machine): Promise<CheckLine> {
  const name = 'python (cortex-guard)'
  const tried: string[] = []
  for (const candidate of PYTHON_CANDIDATES) {
    try {
      const ran = await m.run([candidate, '--version'])
      if (ran.exitCode === 0) {
        const before = tried.length === 0 ? '' : `; before it ${tried.join('; ')}`

        return line('ok', name, `${candidate} answers: ${firstLine(ran.stdout) || firstLine(ran.stderr) || 'exit 0'} (tried in order ${PYTHON_CANDIDATES.join(', ')}${before})`)
      }
      tried.push(`${candidate}: exit ${ran.exitCode}: ${firstLine(ran.stderr) || firstLine(ran.stdout) || 'no output'}`)
    } catch (error) {
      tried.push(`${candidate}: could not start: ${why(error)}`)
    }
  }
  return line('FAIL', name, `none of ${PYTHON_CANDIDATES.join(', ')} started: ${tried.join('; ')}`)
}

export async function runChecks(m: Machine, own: Own): Promise<string> {
  const listed = await configRows(m)
  const rows = 'rows' in listed ? listed.rows : undefined
  const mods = await checkMods(m)
  const lines: CheckLine[] = [
    ...mods.lines,
    ...checkOptions(rows, 'error' in listed ? listed.error : undefined, own, mods.states),
    await checkPython(m),
    await checkHygiene(m, rows),
    await checkCortex(m, own.server),
    await checkCommand(m, 'gh --version', ['gh', '--version']),
    await checkGhAuth(m),
    await checkRateLimit(m),
    await checkCommand(m, 'git remote (harness-fleet)', ['git', 'remote']),
    ...(await checkFleetRecords(m, rows)),
    await checkPs(m),
    await checkCommand(m, 'pandoc (cortex-wiki)', ['pandoc', '--version']),
    await checkCommand(m, 'xelatex (cortex-wiki)', ['xelatex', '--version']),
    checkModels(rows, mods.states),
  ]
  const failed = lines.filter((l) => l.status === 'FAIL').length

  return `/cortex check: ${failed === 0 ? 'every check passed' : `${failed} failed`}, reads only\n${renderLines(lines)}`
}
