import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  Classified,
  ContextHealth,
  PolicyDecision,
  PolicyState,
  CortexEntry,
  CortexStats,
  HygieneSnapshot,
  Refusal,
  StageTally,
  TurnTally,
} from '../types'
import {
  SHAPES_PATH,
  SHAPE_SKILL_PREFIX,
  STUCK_ERRORS,
  type Shape,
  classifierPrompt,
  classifierSystem,
  effortForClass,
  escalate,
  isClassifiable,
  parseClassification,
  parseShapes,
  shapeContext,
} from './classify'
import { THRESHOLDS_PATH, band, crossed, matchThresholds, serversOf } from './context'
import { type CallInput, judgeCall, judgePath, worktreeAddPath } from './guard'
import { OWNERSHIP_PATH, parseOwnership, testProcesses, worktrees } from './hygiene'
import { begin, emptyTally, finish, group, isCortexTool, parseStats, shortTool } from './model'
import { bump, emptyStages, stageOf } from './pipeline'
import { CHARS_PER_TOKEN, LEAN_TOOLS, currentEffort, effortFor, leanText, pressureOf } from './policy'
import { inputGist, outputText, parseRecall } from './recall'
import { mainModelFor, routeAgentModel } from './route'
import { RecallResultView, UseRowView } from './rows'
import { type Surface, tone } from './tokens'
import { Cockpit } from './view'
import { pandocArgv, toPandocSource, wikiTarget } from './wiki'

const PANE = 'cortex-cockpit'
const LEDGER_CAP = 200 // source: bounds $.state size; the pane shows the last rows only
const SLOW_MS = 2000 // source: memory_stats states ~75 ms; a call ten times slower is worth a word
const RETRY_MS = [2000, 5000, 15000] // source: own choice, MCP servers connect after the mod loads

const ledger = atom({ plugin: 'cortex-cockpit', key: 'ledger' } as const, [] as CortexEntry[])
const stats = atom({ plugin: 'cortex-cockpit', key: 'stats' } as const, null as CortexStats | null)
const statsError = atom(
  { plugin: 'cortex-cockpit', key: 'statsError' } as const,
  null as string | null,
)
const tally = atom({ plugin: 'cortex-cockpit', key: 'tally' } as const, emptyTally())
const context = atom(
  { plugin: 'cortex-cockpit', key: 'context' } as const,
  null as ContextHealth | null,
)
const stages = atom(
  { plugin: 'cortex-cockpit', key: 'stages' } as const,
  emptyStages() as Record<string, StageTally>,
)
const refusals = atom({ plugin: 'cortex-cockpit', key: 'refusals' } as const, [] as Refusal[])
const hygiene = atom(
  { plugin: 'cortex-cockpit', key: 'hygiene' } as const,
  null as HygieneSnapshot | null,
)
const policy = atom({ plugin: 'cortex-cockpit', key: 'policy' } as const, {
  mode: 'observe',
  pressure: 'none',
  quotaPercent: 80,
  resultCapChars: 16000,
  decisions: [],
  charsCut: 0,
  classifierModel: 'haiku',
  classified: null,
  classifierError: null,
  errorsInRow: 0,
  shapesLoaded: 0,
} as PolicyState)
const DECISIONS_CAP = 50 // source: bounds $.state size; the pane shows the last rows only
const CLASSIFIER_MAX_TOKENS = 120 // source: own choice, the JSON answer is under 40 tokens
const CLASSIFIER_TIMEOUT_MS = 4000 // source: own choice, a prompt must not wait longer on its classifier
const BIND_HEAD_CHARS = 200 // source: own choice, the opening of a prompt identifies it at turn.start

const decide = (p: PolicyState, d: PolicyDecision, charsCut = 0): PolicyState => ({
  ...p,
  decisions: [...p.decisions, d].slice(-DECISIONS_CAP),
  charsCut: p.charsCut + charsCut,
})

// Tools after which the memory population changes, so the headline numbers are re-read.
// source: Cortex handlers that write (mcp_server/handlers/*: remember, forget, consolidate, ...).
const MUTATING = new Set(['remember', 'forget', 'consolidate', 'checkpoint', 'import_sessions'])

const surfaceOf = (value: unknown): Surface => (value === 'paper' ? 'paper' : 'ink')

// A tool_result's content as the Messages API spells it: a string, or text blocks (joined here).
const resultText = (content: unknown): string | undefined => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const texts = content
    .map((b) => (b as { type?: string; text?: string }))
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
  return texts.length === content.length ? texts.join('\n') : undefined
}

// Module state the readers share: where the repo is and which Cortex server to call.
let repo = ''
let server = 'plugin_hypermnesia-mcp_cortex'
let hygieneScript = ''
let shapes: Shape[] = []

const expandHome = async ($: EngineInterface, path: string): Promise<string> =>
  path.startsWith('~/') ? `${(await $.env.get('HOME')) ?? ''}/${path.slice(2)}` : path

// The reasoning shapes come from the generated routing table, read at start; absent, the
// classifier still grades effort and attaches no skill.
async function loadShapes($: EngineInterface): Promise<void> {
  try {
    shapes = parseShapes(await $.fs.read(await expandHome($, SHAPES_PATH)))
    await update($, policy, (p) => ({ ...p, shapesLoaded: shapes.length }))
  } catch (error) {
    shapes = []
    await update($, policy, (p) => ({
      ...p,
      shapesLoaded: 0,
      classifierError: `${SHAPES_PATH}: ${String(error).slice(0, 100)}`,
    }))
  }
}

// One low-effort completion grades the request; anything but a strict answer is no decision.
async function classify($: EngineInterface, text: string): Promise<Classified | undefined> {
  const p = await read($, policy)
  const started = await $.clock.now()
  const r = await $.model.complete({
    model: p.classifierModel,
    effort: 'low',
    system: [{ text: classifierSystem(shapes), cache: true }],
    prompt: classifierPrompt(text),
    maxTokens: CLASSIFIER_MAX_TOKENS,
    timeoutMs: CLASSIFIER_TIMEOUT_MS,
  })
  const now = await $.clock.now()
  if (!r.isAnswered) {
    await update($, policy, (s) => ({ ...s, classifierError: `classifier ${r.reason}` }))
    return undefined
  }
  const c = parseClassification(r.text, shapes)
  if (c === undefined) {
    await update($, policy, (s) => ({
      ...s,
      classifierError: `classifier answered off-contract: ${r.text.slice(0, 80)}`,
    }))
    return undefined
  }
  const classified: Classified = {
    turnId: null,
    text,
    taskClass: c.taskClass,
    effort: effortForClass(c.taskClass),
    shapes: c.shapes,
    ms: now - started,
    at: now,
  }
  await update($, policy, (s) => ({ ...s, classified, classifierError: null }))
  return classified
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

type Measured = {
  context: {
    tokens?: number
    window: number
    percent?: number
    breakdown?: {
      categories: readonly { name: string; tokens: number }[]
      mcpTools: readonly { serverName: string; tokens: number }[]
    }
  }
  rateLimits: readonly { kind: string; percentUsed: number }[]
  cost?: { usd: number }
}

// A measure carries no breakdown; the one read before is kept until the next full read.
async function readContext(
  $: EngineInterface,
  m: Measured,
  before: ContextHealth | null,
): Promise<ContextHealth> {
  const model = await $.session.model()
  let warn: number | null = null
  let hard: number | null = null
  let source = `${THRESHOLDS_PATH} absent`
  try {
    const t = matchThresholds(await $.fs.read(await expandHome($, THRESHOLDS_PATH)), model)
    if (t !== undefined) {
      warn = t.warn
      hard = t.hard
      source = THRESHOLDS_PATH
    } else source = `${THRESHOLDS_PATH} has no match for ${model}`
  } catch {
    // The file is the Stop guard's; absent means no thresholds, which the pane says.
  }
  return {
    tokens: m.context.tokens ?? null,
    window: m.context.window,
    percent: m.context.percent ?? null,
    model,
    warn,
    hard,
    thresholdsSource: source,
    rateLimits: m.rateLimits.map((r) => ({ kind: r.kind, percentUsed: r.percentUsed })),
    usd: m.cost?.usd ?? null,
    categories:
      m.context.breakdown?.categories.map((c) => ({ name: c.name, tokens: c.tokens })) ??
      before?.categories ??
      [],
    mcpServers:
      m.context.breakdown === undefined
        ? (before?.mcpServers ?? [])
        : serversOf(m.context.breakdown.mcpTools),
    readAt: await $.clock.now(),
  }
}

// The full read, with the window broken down as /context does it: at start and on Refresh.
async function refreshContext($: EngineInterface): Promise<void> {
  const before = await read($, context)
  const after = await readContext($, await $.session.usage({ breakdown: 'summary' }), before)
  await update($, context, () => after)
}

async function refreshHygiene($: EngineInterface): Promise<void> {
  const readAt = await $.clock.now()
  let snapshot: HygieneSnapshot
  try {
    const list = await $.process.run(['git', 'worktree', 'list', '--porcelain'], { cwd: repo })
    let ownership: string | undefined
    try {
      ownership = await $.fs.read(await expandHome($, OWNERSHIP_PATH))
    } catch {
      ownership = undefined
    }
    const ps = await $.process.run(['ps', '-eo', 'pid,etime,command'])
    snapshot =
      list.exitCode === 0
        ? {
            worktrees: worktrees(list.stdout, ownership === undefined ? undefined : parseOwnership(ownership)),
            testProcesses: testProcesses(ps.stdout),
            error: null,
            readAt,
          }
        : { worktrees: [], testProcesses: [], error: list.stderr.slice(0, 120), readAt }
  } catch (error) {
    snapshot = { worktrees: [], testProcesses: [], error: String(error).slice(0, 120), readAt }
  }
  await update($, hygiene, () => snapshot)
}

// Where a path lands once links and `..` are resolved; the spelling when it does not exist yet.
async function realPathOf($: EngineInterface, path: string): Promise<string> {
  try {
    const stat = await $.fs.stat(path, { resolve: true })
    return (stat as { realPath?: string }).realPath ?? path
  } catch {
    return path
  }
}

// Pairs with the worktree rule: a worktree that exists is registered, as CLAUDE.md prescribes.
async function registerWorktree($: EngineInterface, path: string): Promise<void> {
  if (hygieneScript === '') return
  const real = await realPathOf($, path)
  const ran = await $.process.run([
    'python3',
    hygieneScript,
    '--host',
    'claude',
    '--session',
    await $.session.id(),
    'register-worktree',
    '--repo',
    repo,
    '--path',
    real,
  ])
  $.ui.toast(
    ran.exitCode === 0
      ? `worktree registered: ${real}`
      : `worktree NOT registered (${ran.stderr.slice(0, 80)})`,
  )
  void refreshHygiene($)
}

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
  hygieneScript = String(options.hygiene_script ?? '')
  const policyMode: PolicyState['mode'] = options.policy_mode === 'enforce' ? 'enforce' : 'observe'
  const quotaPercent = Number(options.quota_pressure_percent ?? 80)
  const resultCapChars = Number(options.result_cap_chars ?? 16000)
  const classifierModel = String(options.classifier_model ?? 'haiku')
  const surface = surfaceOf(options.surface)
  // A hot reload keeps $.state from the previous load: fields this version added are filled in.
  const configured = (p: PolicyState): PolicyState => ({
    ...p,
    mode: policyMode,
    quotaPercent,
    resultCapChars,
    classifierModel,
    classified: p.classified ?? null,
    classifierError: p.classifierError ?? null,
    errorsInRow: p.errorsInRow ?? 0,
    shapesLoaded: p.shapesLoaded ?? 0,
  })

  on('session.start', async ($, e, next) => {
    repo = (await $.session.repo())?.root ?? e.cwd
    await update($, policy, configured)
    await loadShapes($)
    void refreshStats($)
    void refreshHygiene($)
    await refreshContext($)
    await $.command.register({
      name: 'wiki',
      description: 'Compile a wiki page (Markdown with ```tikz blocks) to PDF and open it',
      argumentHint: '<wiki/**.md>',
    })
    // Registered last: a taken name throws and would skip the rest of this hook.
    try {
      await $.command.register({
        name: 'cortex',
        description: 'Open the Cortex cockpit pane',
        immediate: true,
      })
    } catch (error) {
      $.ui.toast(`/cortex is taken by another plugin: ${String(error).slice(0, 80)}`)
    }

    return next(e)
  })

  // /clear, /resume and /branch reset $.state and never fire session.start again.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await update($, policy, configured)
    await loadShapes($)
    await refreshContext($)

    return next(e)
  })

  // The request classifier: task class → the turn's effort, reasoning shapes → the skills to
  // load first. Observed, the prompt goes through untouched; enforced, the shapes ride beside it.
  on('prompt.submit', async ($, e, next) => {
    if (!isClassifiable(e.text, e.origin)) return next(e)
    const c = await classify($, e.text)
    if (c === undefined || c.shapes.length === 0) return next(e)
    const applied = (await read($, policy)).mode === 'enforce'
    const d: PolicyDecision = {
      at: c.at,
      kind: 'shape',
      subject: c.shapes.join(' + '),
      from: 'none',
      to: c.shapes.map((s) => `${SHAPE_SKILL_PREFIX}${s}`).join(', '),
      applied,
    }
    await update($, policy, (s) => decide(s, d))
    return applied ? next({ ...e, context: [...(e.context ?? []), shapeContext(c.shapes)] }) : next(e)
  })

  // prompt.submit's turnId is the turn that was running, not the one the prompt starts: the
  // classification binds to its turn here, by the prompt's opening.
  on('turn.start', async ($, e, next) => {
    const p = await read($, policy)
    const c = p.classified
    const isOurs =
      c !== null &&
      c.turnId === null &&
      c.text.slice(0, BIND_HEAD_CHARS) === e.text.slice(0, BIND_HEAD_CHARS)
    await update($, policy, (s) => ({
      ...s,
      classified: isOurs && c !== null ? { ...c, turnId: e.turnId } : s.classified,
      errorsInRow: 0,
    }))

    return next(e)
  })

  on('command.run', { command: 'cortex' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'Cortex' })
    void refreshStats($)
    void refreshHygiene($)

    return { text: 'Cortex cockpit opened.' }
  })

  on('command.run', { command: 'wiki' }, async ($, e) => {
    const target = wikiTarget(e.args)
    if (!target.ok) return { text: target.reason }
    const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')
    const out = `${tmp}/cortex-wiki-${target.path.replace(/[^A-Za-z0-9]+/g, '-')}.pdf`
    const source = toPandocSource(await $.fs.read(target.path))
    const built = await $.process.run(pandocArgv('-', out), { stdin: source, timeoutMs: 120_000 })
    if (built.exitCode !== 0) return { text: `TeX build failed:\n${built.stderr.slice(0, 600)}` }
    await $.process.run(['open', out])

    return { text: `Compiled and opened ${out}` }
  })

  // The two rules no settings hook enforces; fail closed: a guard that throws refuses.
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit', 'Bash'] }, async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as CallInput
    let verdict = judgeCall(tool, input)
    if (verdict.allow && input.file_path !== undefined)
      verdict = judgePath(await realPathOf($, input.file_path))
    if (verdict.allow) return next(e)
    const target = input.file_path ?? input.notebook_path ?? (input.command ?? '').slice(0, 60)
    const at = await $.clock.now()
    await update($, refusals, (list) => [...list, { at, tool, rule: verdict.rule, target }])
    $.ui.toast(`refused ${tool}: ${verdict.rule}`)

    return { deny: `cortex-cockpit (${verdict.rule}): ${verdict.reason}` }
  }).catch(($, e, next) =>
    next.called
      ? next(e)
      : { deny: `cortex-cockpit: its guard failed on ${String(e.tool)}, so the call was refused.` },
  )

  // Observer: tallies every tool, places it on the pipeline, and keeps the Cortex ledger.
  on('tool.call', async ($, e, next) => {
    const name = String(e.tool)
    const short = shortTool(name)
    const stage = stageOf(name, e as { command?: string })
    await update($, tally, (t: TurnTally) => ({
      ...t,
      tools: { ...t.tools, [short]: (t.tools[short] ?? 0) + 1 },
    }))
    const entry =
      isCortexTool(name) && e.tool_use_id !== undefined
        ? begin(e.tool_use_id, name, await $.clock.now())
        : undefined
    if (entry !== undefined) await update($, ledger, (list) => [...list, entry].slice(-LEDGER_CAP))

    const ran = await next(e)
    const now = await $.clock.now()
    const isBlocked = ran.deny !== undefined || ran.isError === true
    if (stage !== undefined) await update($, stages, (s) => bump(s, stage, name, now, isBlocked))
    // The stuck signal: main's tool errors in a row, read by the next turn.step.
    if ((e as { agentId?: string }).agentId === undefined)
      await update($, policy, (s) => ({ ...s, errorsInRow: isBlocked ? s.errorsInRow + 1 : 0 }))
    if (entry !== undefined) {
      const done = finish(entry, now, ran.text ?? '', isBlocked)
      await update($, ledger, (list) => list.map((one) => (one.id === entry.id ? done : one)))
      if ((done.ms ?? 0) >= SLOW_MS) $.ui.status(`cortex ${short} slow: ${group(done.ms ?? 0)} ms`)
      if (MUTATING.has(short)) void refreshStats($)
    }
    if (name === 'Bash' && !isBlocked) {
      const added = worktreeAddPath((e as { command?: string }).command ?? '')
      if (added !== undefined) void registerWorktree($, added)
    }

    return ran
  })

  on('session.measure', async ($, e, next) => {
    const before = await read($, context)
    const after = await readContext($, e, before)
    await update($, context, () => after)
    const pressure = pressureOf(after.rateLimits, quotaPercent, band(after))
    await update($, policy, (p) => ({ ...p, pressure }))
    const crossing = crossed(before, after)
    if (crossing !== undefined)
      $.ui.toast(
        `context ${crossing}: ${group(after.tokens ?? 0)} tokens, the Stop guard will ${
          crossing === 'hard' ? 'block the stop' : 'ask for a checkpoint'
        }`,
      )

    return next(e)
  })

  // The effort ladder from the classified rung, the stuck escalation, and main's model under
  // quota: observed, or applied under enforce. A generator, as the event streams.
  on('turn.step', async function* ($, e, next) {
    const p = await read($, policy)
    const isMain = e.agentId === undefined
    const c = isMain && p.classified !== null && p.classified.turnId === e.turnId ? p.classified : null
    const have = currentEffort(e.model, e.effort)
    let target = effortFor(e.model, e.index, e.effort, p.pressure, c?.effort) ?? have
    let kind: PolicyDecision['kind'] = 'effort'
    if (isMain && p.errorsInRow >= STUCK_ERRORS) {
      const raised = escalate(target)
      if (raised !== target) {
        target = raised
        kind = 'stuck'
      }
      await update($, policy, (s) => ({ ...s, errorsInRow: 0 }))
    }
    const model = isMain ? mainModelFor(e.model, p.pressure) : undefined
    if (target === have && model === undefined) return yield* next(e)
    const applied = p.mode === 'enforce'
    const at = await $.clock.now()
    const who = `${isMain ? 'main' : 'agent'} step ${e.index} (${e.model})`
    if (target !== have) {
      const subject = c !== null && e.index === 0 ? `${who} · ${c.taskClass}` : who
      await update($, policy, (s) =>
        decide(s, { at, kind, subject, from: String(e.effort ?? 'default'), to: target, applied }),
      )
    }
    if (model !== undefined && e.index === 0)
      await update($, policy, (s) =>
        decide(s, { at, kind: 'model', subject: 'main · quota pressure', from: e.model, to: model, applied }),
      )
    if (!applied) return yield* next(e)
    return yield* next({
      ...e,
      ...(target !== have ? { effort: target } : {}),
      ...(model !== undefined ? { model } : {}),
    })
  })

  // Subagents: the family the type and the turn's class call for, one notch down under pressure.
  on('agent.spawn', async ($, e, next) => {
    const p = await read($, policy)
    const cls = e.parentAgentId === undefined && p.classified !== null ? p.classified.taskClass : undefined
    const target = routeAgentModel(e.subagentType, e.model, e.parentModel, p.pressure, cls)
    if (target === undefined) return next(e)
    const applied = p.mode === 'enforce'
    const d: PolicyDecision = {
      at: await $.clock.now(),
      kind: 'model',
      subject: `${e.subagentType}${cls === undefined ? '' : ` · ${cls}`}`,
      from: e.model ?? `inherit ${e.parentModel}`,
      to: target,
      applied,
    }
    await update($, policy, (s) => decide(s, d))
    return next(applied ? { ...e, model: target } : e)
  })

  // Memory leaning: a streaming tool's long result keeps head and tail before it is stored.
  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    const tool = e.origin.kind === 'tool' ? e.origin.tool : undefined
    if (tool === undefined || !LEAN_TOOLS.has(tool)) return next(e)
    const p = await read($, policy)
    let cut = 0
    const content = e.message.content.map((block) => {
      if (block.type !== 'tool_result') return block
      const text = resultText(block.content)
      if (text === undefined) return block
      const lean = leanText(text, p.resultCapChars)
      if (lean === undefined) return block
      cut += lean.cut
      if (p.mode !== 'enforce') return block
      return typeof block.content === 'string'
        ? { ...block, content: lean.text }
        : { ...block, content: [{ type: 'text', text: lean.text }] }
    })
    if (cut === 0) return next(e)
    const d: PolicyDecision = {
      at: await $.clock.now(),
      kind: 'lean',
      subject: tool,
      from: `${group(cut)} chars`,
      to: `about ${group(Math.round(cut / CHARS_PER_TOKEN))} tokens kept out`,
      applied: p.mode === 'enforce',
    }
    await update($, policy, (s) => decide(s, d, p.mode === 'enforce' ? cut : 0))
    return next({ ...e, message: { ...e.message, content } })
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
      context: await read($, context),
      stages: await read($, stages),
      refusals: await read($, refusals),
      hygiene: await read($, hygiene),
      policy: await read($, policy),
      onRefresh: () => {
        void refreshStats($)
        void refreshHygiene($)
        void refreshContext($)
      },
      onConsolidate: () => void consolidateNow($),
      onCurateWiki: () =>
        void $.prompt.submit({
          text: 'Call curate_wiki, then write each authoring job it returns with wiki_write.',
        }),
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
    const c = await read($, context)
    const failure = await read($, statsError)
    if (e.props.hasSurvey || (s === null && failure === null && c === null)) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const refused = (await read($, refusals)).length
    const calls = (await read($, ledger)).length
    const p = await read($, policy)
    const ctx = c === null || c.percent === null ? 'ctx: no reading' : `ctx ${c.percent} %`
    const mem = s === null ? 'stats blocked' : `${group(s.total_memories)} memories`
    const k = p.classified
    const graded =
      k === null
        ? `${p.mode} · no request classified`
        : `${p.mode} · ${k.taskClass} → effort ${k.effort} · ${
            k.shapes.length === 0 ? 'no shape' : `shape ${k.shapes.join(' + ')}`
          }`
    const trouble = p.classifierError === null ? '' : ` · ${p.classifierError}`

    return (
      <Box>
        <Text color={s === null ? tone(surface, 'danger') : undefined} dimColor={s !== null}>
          cortex · {ctx} · {mem} · {group(calls)} calls ·{' '}
          {refused === 0 ? 'nothing refused' : `${group(refused)} refused`} · {graded}
          {p.pressure === 'none' ? '' : ` · pressure ${p.pressure}`}
          {trouble}{' '}
        </Text>
        <Button
          key="open"
          label="Cockpit"
          onPress={() => void $.ui.open({ id: PANE, title: 'Cortex' })}
        />
      </Box>
    )
  })
}
