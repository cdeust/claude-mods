import { atom, read, update } from 'claude-code'
import type { AgentSpawnResult, EngineInterface, PluginState, Register, TurnStepChunk, TurnStepResult } from 'claude-code'

import type { ContextHealth, PhasesState, PolicyDecision, PolicyState } from '../types'
import { type Definition, INHERITING_BUILT_INS, INSTALLED_PLUGINS_PATH, definitionPaths, parseDefinition } from './agents'
import { placePath } from './paths'
import { emptyPhases, finished, spawned, startTurn, stepPhase, stepped } from './phases'
import { THRESHOLDS_PATH, band, crossed, matchThresholds, serversOf } from './context'
import {
  CHARS_PER_TOKEN,
  LEAN_TOOLS,
  STUCK_ERRORS,
  agentEffortFor,
  currentEffort,
  effortFor,
  escalate,
  group,
  leanText,
  pressureOf,
  resultText,
} from './policy'
import { type TaskClass, mainModelFor, routeAgentModel } from './route'

const DECISIONS_CAP = 50 // source: bounds $.state size; a viewer shows the last rows only

const context = atom({ plugin: 'zetetic-autopilot', key: 'context' } as const, null as ContextHealth | null)
const policy = atom({ plugin: 'zetetic-autopilot', key: 'policy' } as const, {
  mode: 'observe',
  pressure: 'none',
  quotaPercent: 80,
  resultCapChars: 16000,
  decisions: [],
  charsCut: 0,
  errorsInRow: 0,
} as PolicyState)

const phases = atom({ plugin: 'zetetic-autopilot', key: 'phases' } as const, emptyPhases() as PhasesState)

// The classifier's verdict is zetetic-genius's state (a dependency): read, never written here.
const geniusState = { plugin: 'zetetic-genius', key: 'state' } as const
type Grade = { turnId: string | null; taskClass: TaskClass; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }

const decide = (p: PolicyState, d: PolicyDecision, charsCut = 0): PolicyState => ({
  ...p,
  decisions: [...p.decisions, d].slice(-DECISIONS_CAP),
  charsCut: p.charsCut + charsCut,
})

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

// The current grade. A genius mod that is not loaded leaves the value undefined, a known state
// (no grade); a read that fails is another condition, named in a decision row (issue #6).
async function gradeOf($: EngineInterface): Promise<Grade | undefined> {
  let value: PluginState['zetetic-genius']['state'] | undefined
  try {
    value = (await $.state.get(geniusState)).value
  } catch (error) {
    await note($, 'zetetic-genius state', `unreadable: ${String(error).slice(0, 100)}`)
    return undefined
  }
  const c = value?.classified
  return c === null || c === undefined ? undefined : { turnId: c.turnId, taskClass: c.taskClass, effort: c.effort }
}

// A failed read, logged once until its reason changes: the POLICY panel shows it, routing goes on
// without what could not be read.
async function note($: EngineInterface, subject: string, reason: string): Promise<void> {
  const p = await read($, policy)
  const last = p.decisions.findLast((d) => d.kind === 'unread' && d.subject === subject)
  if (last?.to === reason) return
  const at = await $.clock.now()
  await update($, policy, (s) => decide(s, { at, kind: 'unread', subject, from: '', to: reason, applied: false }))
}

// Agent definitions, read once per type and session: what the type's file pins, or why it could
// not be read. The built-ins measured to inherit pin nothing and have no file.
const definitions = new Map<string, Definition | { unread: string }>()

async function definitionOf($: EngineInterface, type: string): Promise<Definition | { unread: string }> {
  const known = definitions.get(type)
  if (known !== undefined) return known
  const found = INHERITING_BUILT_INS.includes(type) ? {} : await readDefinition($, type)
  definitions.set(type, found)
  return found
}

async function readDefinition($: EngineInterface, type: string): Promise<Definition | { unread: string }> {
  try {
    const claudeDir = (await expandHome($, '~/.claude')).replace(/\/$/, '')
    const installed = type.includes(':') ? await $.fs.read(await expandHome($, INSTALLED_PLUGINS_PATH)) : undefined
    const paths = definitionPaths(type, installed, claudeDir, await $.session.cwd())
    for (const path of paths) {
      const text = await $.fs.read(path).then(String, () => undefined)
      if (text !== undefined) return parseDefinition(text)
    }
    return { unread: paths.length === 0 ? 'no installed plugin provides it' : `no file at ${paths.join(', ')}` }
  } catch (error) {
    return { unread: String(error).slice(0, 120) }
  }
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
async function readContext($: EngineInterface, m: Measured, before: ContextHealth | null): Promise<ContextHealth> {
  const model = await $.session.model()
  let warn: number | null = null
  let hard: number | null = null
  let source = THRESHOLDS_PATH
  try {
    const t = matchThresholds(await $.fs.read(await expandHome($, THRESHOLDS_PATH)), model)
    if (t !== undefined) {
      warn = t.warn
      hard = t.hard
    } else source = `${THRESHOLDS_PATH} has no match for ${model}`
  } catch (error) {
    // The file is the Stop guard's. A refusal, a missing file and a file that is not JSON all leave
    // no thresholds; the viewer is told which, with the reason, instead of reading all three as absent.
    source = `${THRESHOLDS_PATH} unreadable: ${(error instanceof Error ? error.message : String(error)).slice(0, 100)}`
  }
  const reading = { tokens: m.context.tokens ?? null, warn, hard }
  return {
    ...reading,
    window: m.context.window,
    percent: m.context.percent ?? null,
    model,
    thresholdsSource: source,
    rateLimits: m.rateLimits.map((r) => ({ kind: r.kind, percentUsed: r.percentUsed })),
    usd: m.cost?.usd ?? null,
    categories:
      m.context.breakdown?.categories.map((c) => ({ name: c.name, tokens: c.tokens })) ?? before?.categories ?? [],
    mcpServers: m.context.breakdown === undefined ? (before?.mcpServers ?? []) : serversOf(m.context.breakdown.mcpTools),
    band: band(reading),
    readAt: await $.clock.now(),
  }
}

// The full read, with the window broken down as /context does it: at start.
async function refreshContext($: EngineInterface): Promise<void> {
  const before = await read($, context)
  const after = await readContext($, await $.session.usage({ breakdown: 'summary' }), before)
  await update($, context, () => after)
}

// The step as it went out and what came back: its phase and its advisor calls, on its loop's row.
async function* tracked(
  $: EngineInterface,
  sent: { turnId: string; index: number; model: string; effort?: string | number; agentId?: string },
  stream: AsyncGenerator<TurnStepChunk, TurnStepResult>,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const r = yield* stream
  const at = await $.clock.now()
  const advisorCalls = (r.serverToolUses ?? []).filter((u) => u.name === 'advisor').length
  // turn.start carries no loop id and fires for a subagent's turn too (measured 2026-10-14): main's
  // row starts again at main's own first step of a new turn instead.
  const isNewMainTurn = sent.agentId === undefined && (await read($, phases)).turnId !== sent.turnId
  if (isNewMainTurn) await update($, phases, (s) => startTurn(s, sent.turnId, sent.model, at))
  await update($, phases, (s) =>
    stepped(s, {
      loopId: sent.agentId ?? 'main',
      model: r.usage?.model ?? sent.model,
      effort: sent.effort === undefined ? null : String(sent.effort),
      phase: stepPhase(r.toolUses, r.answer),
      advisorCalls,
      at,
    }),
  )
  return r
}

// A started subagent gets its row: the model the engine resolved, the phase its type names.
async function placed(
  $: EngineInterface,
  e: { subagentType: string; description: string },
  r: AgentSpawnResult,
): Promise<AgentSpawnResult> {
  if (r.deny !== undefined || r.agentId === undefined) return r
  const at = await $.clock.now()
  const id = r.agentId
  await update($, phases, (s) => spawned(s, { id, type: e.subagentType, description: e.description, model: r.model, at }))
  return r
}

export const register: Register = (on, options) => {
  const mode: PolicyState['mode'] = options.policy_mode === 'enforce' ? 'enforce' : 'observe'
  const quotaPercent = Number(options.quota_pressure_percent ?? 80)
  const resultCapChars = Number(options.result_cap_chars ?? 16000)
  // A hot reload keeps $.state from the previous load: the configured fields are set afresh.
  const configured = (p: PolicyState): PolicyState => ({ ...p, mode, quotaPercent, resultCapChars })

  on('session.start', async ($, e, next) => {
    definitions.clear()
    await update($, phases, () => emptyPhases())
    await update($, policy, configured)
    await refreshContext($)

    return next(e)
  })

  // /clear, /resume and /branch reset $.state and never fire session.start again.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    definitions.clear()
    await update($, phases, () => emptyPhases())
    await update($, policy, configured)
    await refreshContext($)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const before = await read($, context)
    const after = await readContext($, e, before)
    await update($, context, () => after)
    const pressure = pressureOf(after.rateLimits, quotaPercent, after.band)
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

  // Main: the effort ladder from the graded rung, the stuck escalation, and the model under
  // quota. A subagent: the effort its definition pinned, capped under pressure. Observed, or
  // applied under enforce. A generator, as the event streams.
  on('turn.step', async function* ($, e, next) {
    const p = await read($, policy)
    const isMain = e.agentId === undefined
    const grade = isMain ? await gradeOf($) : undefined
    const g = grade !== undefined && grade.turnId === e.turnId ? grade : undefined
    const have = currentEffort(e.model, e.effort)
    let target =
      (isMain ? effortFor(e.model, e.index, e.effort, p.pressure, g?.effort) : agentEffortFor(e.model, e.effort, p.pressure)) ??
      have
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
    if (target === have && model === undefined) return yield* tracked($, e, next(e))
    const applied = p.mode === 'enforce'
    const at = await $.clock.now()
    const who = `${isMain ? 'main' : 'agent'} step ${e.index} (${e.model})`
    if (target !== have) {
      const subject = g !== undefined && e.index === 0 ? `${who} · ${g.taskClass}` : who
      await update($, policy, (s) => decide(s, { at, kind, subject, from: String(e.effort ?? 'default'), to: target, applied }))
    }
    if (model !== undefined && e.index === 0)
      await update($, policy, (s) =>
        decide(s, { at, kind: 'model', subject: 'main · quota pressure', from: e.model, to: model, applied }),
      )
    if (!applied) return yield* tracked($, e, next(e))
    const out = { ...e, ...(target !== have ? { effort: target } : {}), ...(model !== undefined ? { model } : {}) }
    return yield* tracked($, out, next(out))
  })

  // Subagents: the model the call or the definition pinned stands, one notch down under pressure;
  // an inheriting type runs on the family its kind and the turn's class call for.
  on('agent.spawn', async ($, e, next) => {
    const p = await read($, policy)
    // The grade counts only for the main turn it was bound to: a later turn nobody graded (a slash
    // command, a notification) routes without one, as turn.step does.
    const grade = e.parentAgentId === undefined ? await gradeOf($) : undefined
    const mainTurn = (await read($, phases)).turnId
    const cls = grade !== undefined && grade.turnId !== null && grade.turnId === mainTurn ? grade.taskClass : undefined
    const found = e.model === undefined ? await definitionOf($, e.subagentType) : {}
    if ('unread' in found) await note($, `${e.subagentType} definition`, found.unread)
    const definition = 'unread' in found ? undefined : found
    const target = routeAgentModel(e.subagentType, e.model, definition, e.parentModel, p.pressure, cls)
    if (target === undefined) return placed($, e, await next(e))
    const applied = p.mode === 'enforce'
    const d: PolicyDecision = {
      at: await $.clock.now(),
      kind: 'model',
      subject: `${e.subagentType}${cls === undefined ? '' : ` · ${cls}`}`,
      from: e.model ?? definition?.model ?? `inherit ${e.parentModel}`,
      to: target,
      applied,
    }
    await update($, policy, (s) => decide(s, d))
    return placed($, e, await next(applied ? { ...e, model: target } : e))
  })

  // The stuck signal: main's tool errors in a row, read by the next turn.step.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if ((e as { agentId?: string }).agentId === undefined) {
      const isBlocked = ran.deny !== undefined || ran.isError === true
      await update($, policy, (s) => ({ ...s, errorsInRow: isBlocked ? s.errorsInRow + 1 : 0 }))
    }

    return ran
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
    const applied = p.mode === 'enforce'
    const d: PolicyDecision = {
      at: await $.clock.now(),
      kind: 'lean',
      subject: tool,
      from: `${group(cut)} chars`,
      to: `about ${group(Math.round(cut / CHARS_PER_TOKEN))} tokens kept out`,
      applied,
    }
    await update($, policy, (s) => decide(s, d, applied ? cut : 0))
    return next({ ...e, message: { ...e.message, content } })
  })

  // The stuck counter is a turn's own; main's ends with its turn.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await update($, policy, (s) => ({ ...s, errorsInRow: 0 }))
    const at = await $.clock.now()
    await update($, phases, (s) => finished(s, e.agentId ?? 'main', at))

    return next(e)
  })
}
