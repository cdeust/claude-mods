import { atom, read, update } from 'claude-code'
import type { AgentSpawnResult, EngineInterface, Hook, Register, TurnStepChunk, TurnStepResult } from 'claude-code'

import type { ContextHealth, PhasesState, PolicyDecision, PolicyState, SpawnRoute } from '../types'
import type { LoopCeilings } from './calibration'
import { definitionOf, forgetDefinitions } from './definitions'
import {
  type Decided,
  callEnded,
  callOf,
  callStarted,
  carry,
  decidedFor,
  holdEffort,
  resetEfforts,
  resumed,
  spawnAnswered,
  spawnPending,
  spawnsSettled,
  stepEffort,
  subagentEffort,
} from './effort'
import { readContext } from './measure'
import { DEFAULT_PREVIEW_CHARS, DEFAULT_THRESHOLD_CHARS, offloadOptions } from './offload'
import { type Sink, offloadBlocks } from './offloadrow'
import { emptyPhases, erred, finished, isFileReadStep, isMainImplementation, spawned, startTurn, stepPhase, stepped } from './phases'
import { crossed } from './context'
import {
  CHARS_PER_TOKEN,
  OFFLOAD_TOOLS,
  STUCK_ERRORS,
  currentEffort,
  defaultEffort,
  effortFor,
  escalate,
  group,
  pressureOf,
} from './policy'
import { type RouteFields, asWritten, keepRoute, marked, openRoutes, rewriteRoutes, routeOf } from './records'
import { mainModelFor, routeAgentModel } from './route'
import { checkConfig, gradeOf, readCeilings } from './reads'
import { SPAWNS_CAP, clipped } from './spawns'
import { dispatchOf, effortRowOf, modelRowOf } from './spawnrows'
import { inBudget, maxParallelOption } from './concurrency'
import { type GateSink, admit, configureGate, ended, released, resetGate, started } from './gate'

const DECISIONS_CAP = 50 // source: bounds $.state size; a viewer shows the last rows only

const context = atom({ plugin: 'zetetic-autopilot', key: 'context' } as const, null as ContextHealth | null)
const policy = atom({ plugin: 'zetetic-autopilot', key: 'policy' } as const, {
  mode: 'observe',
  pressure: 'none',
  quotaPercent: 80,
  offloadThresholdChars: DEFAULT_THRESHOLD_CHARS,
  offloadPreviewChars: DEFAULT_PREVIEW_CHARS,
  decisions: [],
  charsOffloaded: 0,
  errorsInRow: 0,
} as PolicyState)

const phases = atom({ plugin: 'zetetic-autopilot', key: 'phases' } as const, emptyPhases() as PhasesState)

const spawns = atom({ plugin: 'zetetic-autopilot', key: 'spawns' } as const, [] as SpawnRoute[])

const decide = (p: PolicyState, d: PolicyDecision, charsOffloaded = 0): PolicyState => ({
  ...p,
  decisions: [...p.decisions, d].slice(-DECISIONS_CAP),
  charsOffloaded: p.charsOffloaded + charsOffloaded,
})

// A failed read, logged once until its reason changes: the POLICY panel shows it, routing goes on
// without what could not be read.
async function note($: EngineInterface, subject: string, reason: string): Promise<void> {
  const p = await read($, policy)
  const last = p.decisions.findLast((d) => d.kind === 'unread' && d.subject === subject)
  if (last?.to === reason) return
  const at = await $.clock.now()
  await update($, policy, (s) => decide(s, { at, kind: 'unread', subject, from: '', to: reason, applied: false }))
}


// The calibrated tool-loop rung per phase, read at each new main turn (reads.ts).
let ceilings: LoopCeilings = {}

// The full read, with the window broken down as /context does it: at start.
async function refreshContext($: EngineInterface): Promise<void> {
  const before = await read($, context)
  const after = await readContext($, await $.session.usage({ breakdown: 'summary' }), before)
  await update($, context, () => after)
}

// The step as it went out and what came back: its phase and its advisor calls, on its loop's row, and
// whether the stuck escalation set its effort (`escalated`, counted on the run the step lands in).
async function* tracked(
  $: EngineInterface,
  sent: { turnId: string; index: number; model: string; effort?: string | number; agentId?: string },
  stream: AsyncGenerator<TurnStepChunk, TurnStepResult>,
  escalated: boolean,
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
      // The effort the request ran at: the one sent, else the model's API default (policy.ts), so
      // the insights ledger never keeps an effort it cannot calibrate.
      effort: sent.effort === undefined ? defaultEffort(r.usage?.model ?? sent.model) : String(sent.effort),
      phase: stepPhase(r.toolUses, r.answer),
      fileRead: isFileReadStep(r.toolUses),
      escalated,
      advisorCalls,
      at,
    }),
  )
  return r
}

// A started subagent gets its row: the model the engine resolved, the phase its type names; and its
// route, in $.state for the viewers and in $.store (`spawns:<start>:<session>`, spawns.ts) for whoever
// reads the record after the session, so an outcome is attributed to the model that ran and the rule
// that chose it.
async function placed(
  $: EngineInterface,
  e: { subagentType: string; description: string },
  r: AgentSpawnResult,
  route: RouteFields,
): Promise<AgentSpawnResult> {
  if (r.deny !== undefined || r.agentId === undefined) return r
  const at = await $.clock.now()
  const id = r.agentId
  await update($, phases, (s) => spawned(s, { id, type: e.subagentType, description: e.description, model: r.model, at }))
  const record: SpawnRoute = clipped({ at, agentId: id, type: e.subagentType, ...route, ran: r.model })
  await update($, spawns, (s) => [...s, asWritten(record)].slice(-SPAWNS_CAP))
  await keepRoute($, record, (subject, reason) => note($, subject, reason))
  return r
}

// The first step of an agent's run passed down the chain at its decided effort: its records say so, in state and store.
async function markCarried($: EngineInterface, id: string): Promise<void> {
  await update($, spawns, (s) => marked(s, id))
  await rewriteRoutes($, (kept) => marked(kept, id), (subject, reason) => note($, subject, reason))
}

const onMeasure: Hook<'session.measure'> = async ($, e, next) => {
  const before = await read($, context)
  const after = await readContext($, e, before)
  await update($, context, () => after)
  await update($, policy, (p) => ({ ...p, pressure: pressureOf(after.rateLimits, p.quotaPercent, after.band) }))
  const crossing = crossed(before, after)
  if (crossing !== undefined)
    $.ui.toast(
      `context ${crossing}: ${group(after.tokens ?? 0)} tokens, the Stop guard will ${
        crossing === 'hard' ? 'block the stop' : 'ask for a checkpoint'
      }`,
    )

  return next(e)
}

// The turn main is in, set as its step goes out: the engine runs a step's tool calls, and so raises their spawns,
// before the step's stream has ended, which is when its phases row records the turn (tracked).
let mainTurnId: string | undefined

// Main: the effort ladder from the graded rung, the stuck escalation, and the model under
// quota. A subagent: the effort decided at its spawn (effort.ts), else as the engine sent it. Observed,
// or applied under enforce. A generator, as the event streams.
const onStep: Hook<'turn.step'> = async function* ($, e, next) {
  if (e.agentId !== undefined) return yield* agentStep($, e, e.agentId, next)
  mainTurnId = e.turnId
  const p = await read($, policy)
  const grade = await gradeOf($, (subject, reason) => note($, subject, reason))
  const g = grade !== undefined && grade.turnId === e.turnId ? grade : undefined
  const have = currentEffort(e.model, e.effort)
  if (e.index === 0) ceilings = await readCeilings($, (subject, reason) => note($, subject, reason))
  const phase = (await read($, phases)).loops.find((l) => l.id === 'main')?.phase
  const loop = phase === undefined || phase === null || e.index === 0 ? undefined : ceilings[phase]
  let target = effortFor(e.model, e.index, e.effort, p.pressure, g?.effort, loop) ?? have
  let kind: PolicyDecision['kind'] = 'effort'
  if (p.errorsInRow >= STUCK_ERRORS) {
    const raised = escalate(target)
    if (raised !== target) {
      target = raised
      kind = 'stuck'
    }
    await update($, policy, (s) => ({ ...s, errorsInRow: 0 }))
  }
  const model = mainModelFor(e.model, p.pressure)
  // The escalation set this step's effort only when it is applied; that holds too when the raised effort
  // is the one the step came with (it goes out unchanged, no row), since the ladder would have sent it lower.
  const escalated = kind === 'stuck' && p.mode === 'enforce'
  if (target === have && model === undefined) return yield* tracked($, e, next(e), escalated)
  const applied = p.mode === 'enforce'
  const at = await $.clock.now()
  const who = `main step ${e.index} (${e.model})`
  if (target !== have) {
    const subject = g !== undefined && e.index === 0 ? `${who} · ${g.taskClass}` : loop !== undefined ? `${who} · ${phase} calibrated` : who
    await update($, policy, (s) => decide(s, { at, kind, subject, from: String(e.effort ?? 'default'), to: target, applied }))
  }
  if (model !== undefined && e.index === 0)
    await update($, policy, (s) =>
      decide(s, { at, kind: 'model', subject: 'main · quota pressure', from: e.model, to: model, applied }),
    )
  if (!applied) return yield* tracked($, e, next(e), escalated)
  const out = { ...e, ...(target !== have ? { effort: target } : {}), ...(model !== undefined ? { model } : {}) }
  return yield* tracked($, out, next(out), escalated)
}

// A subagent's step: at the effort decided at its spawn under enforce, else as the engine sent it (effort.ts). The
// decision's row was logged once, at the spawn, not on each step. A step of an agent with no decision while spawns
// are in flight may belong to one of them (a background run starts before its spawn answers): it waits for their
// answers, then reads again. An event, not a timer: the engine answers a spawn without waiting on the run.
async function* agentStep(
  $: EngineInterface,
  e: Parameters<Hook<'turn.step'>>[1],
  id: string,
  next: Parameters<Hook<'turn.step'>>[2],
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  if ((await read($, policy)).mode !== 'enforce') return yield* tracked($, e, next(e), false)
  const inFlight = decidedFor(id) === undefined ? spawnsSettled(id) : undefined
  if (inFlight !== undefined) await inFlight
  const effort = stepEffort(decidedFor(id), e.effort)
  if (effort === undefined) return yield* tracked($, e, next(e), false)
  const out = effort === e.effort ? e : { ...e, effort }
  try {
    return yield* tracked($, out, next(out), false)
  } finally {
    // The step was passed down at it, whether its stream then ended, failed or was let go: the run's record says so,
    // once. The mark is bookkeeping: its failure is a row, never the step's outcome.
    if (carry(id)) await markCarried($, id).catch((error: unknown) => note($, 'spawn records', `not marked: ${String(error).slice(0, 100)}`).catch(() => undefined))
  }
}

// The cap's view of the mod: its rows go to the POLICY panel, an agent the engine says is gone closes its row.
const gateSink = ($: EngineInterface): GateSink => ({
  decide: async (d) => {
    await update($, policy, (s) => decide(s, d))
  },
  note: (subject, reason) => note($, subject, reason),
  gone: async (id, at) => {
    await update($, phases, (s) => finished(s, id, at))
  },
})

// Subagents: the model the call or the definition pinned stands, under any pressure; an inheriting
// type runs on the family its kind and the turn's class call for. The quota's cap on how many run at
// once comes first (admit), for the main loop's own spawns only (inBudget).
const onSpawn: Hook<'agent.spawn'> = async ($, e, next) => {
  const p = await read($, policy)
  if (!inBudget(e)) return spawnRouted($, e, next, p)
  const gate = await admit($, e, p, gateSink($))
  if (gate.deny !== undefined) return { deny: gate.deny }
  try {
    const r = await spawnRouted($, e, next, p)
    if (r.deny === undefined && r.agentId !== undefined) started(r.agentId)
    return r
  } finally {
    released(gate.held)
  }
}

async function spawnRouted(
  $: EngineInterface,
  e: Parameters<Hook<'agent.spawn'>>[1],
  next: Parameters<Hook<'agent.spawn'>>[2],
  p: PolicyState,
): Promise<AgentSpawnResult> {
  // The grade counts only for the main turn it was bound to: a later turn nobody graded (a slash
  // command, a notification) routes without one, as turn.step does.
  const grade = e.parentAgentId === undefined ? await gradeOf($, (subject, reason) => note($, subject, reason)) : undefined
  const turnClass = grade !== undefined && grade.turnId !== null && grade.turnId === mainTurnId ? grade.taskClass : undefined
  // Read whatever the call says: the record names the definition's model beside the call's. A fork has no
  // definition: it runs as its parent, and the engine ignores a rewrite of its model or of a workflow agent's
  // content (AgentSpawnInput.model, .workflow), so neither is sent one; nor is a teammate given DESIGN or the table.
  const rewritable = !e.fork && e.workflow === undefined
  const fixed = !rewritable || e.isTeammate === true
  const found = e.fork ? {} : await definitionOf($, e.subagentType)
  if ('unread' in found && e.model === undefined) await note($, `${e.subagentType} definition`, found.unread)
  const definition = 'unread' in found ? undefined : found
  const call = callOf(e.tool_use_id)
  // A resume names its agent (2.1.304 `resume.agentId`): its new run has carried nothing, before that run can step.
  const resuming = (e as { resume?: { agentId?: unknown } }).resume?.agentId
  const d = await dispatchOf($, e, { fixed, seen: call !== undefined, resumed: typeof resuming === 'string', callModel: e.model, definition })
  for (const [subject, why] of d.refused) await note($, subject, why)
  const row = d.row
  if (row !== undefined) await update($, policy, (s) => decide(s, row))
  const steer = d.steer
  const routed = routeAgentModel(e.model, definition, e.parentModel, steer)
  const applied = p.mode === 'enforce' && routed.model !== undefined && rewritable
  const from = e.model ?? definition?.model ?? `inherit ${e.parentModel}`
  const to = routed.model
  if (to !== undefined) {
    const at = await $.clock.now()
    await update($, policy, (s) => decide(s, modelRowOf(at, { type: e.subagentType, steer, from, to, applied })))
  }
  // The effort of its steps (effort.ts): decided before the spawn is passed on, held as soon as it answers.
  const effort = subagentEffort({ fixed, call, definition, steer, grade: turnClass === undefined ? undefined : grade?.effort })
  // Pending until held: a step of the agent that comes before the spawn answers waits for it (agentStep).
  const settle = effort.effort === undefined ? undefined : spawnPending()
  if (typeof resuming === 'string') resumed(resuming)
  let r: AgentSpawnResult
  try {
    r = await next(applied ? { ...e, model: routed.model } : e)
    // Held before the answer is announced: a step it releases reads the decision.
    if (effort.effort !== undefined && r.deny === undefined && r.agentId !== undefined) holdEffort(r.agentId, effort.effort)
    if (r.agentId !== undefined) spawnAnswered(r.agentId)
  } finally {
    settle?.()
  }
  const cls = steer.by === 'table' ? steer.cls : turnClass
  if (effort.effort !== undefined && r.agentId !== undefined) {
    const at = await $.clock.now()
    await update($, policy, (s) => decide(s, effortRowOf(at, { type: e.subagentType, cls, effort, applied: p.mode === 'enforce' })))
  }
  // A resumed agent's record names the effort its steps keep, the one held since its first spawn; its run has
  // carried nothing yet.
  const held = effort.effort === undefined && r.agentId !== undefined ? decidedFor(r.agentId) : undefined
  // An engine whose resume names no agent (2.1.292 types): the reset comes once the spawn answered.
  if (held !== undefined && r.agentId !== undefined && typeof resuming !== 'string') resumed(r.agentId)
  const kept: Decided = held === undefined ? effort : { effort: held, reason: 'resumed' }
  return placed($, e, r, routeOf({ routed, applied, steer, effort: kept, enforce: p.mode === 'enforce' }))
}

// The turns main was last told in, each once a turn and not once a call: the user (a toast) and the model (a
// reminder in the call's result). Reset with the session. The model's is given back when its call was refused,
// so the next call of the turn carries it; the user's is not (a toast says what main did, and the refusal
// is on the screen already).
let toastedTurn: string | null | undefined
let remindedTurn: string | null | undefined

// What the model reads after the result of its first implementing call of a turn (the engine's declarations:
// a tool.call result's `context` is "what the model reads after the tool's result and the user never sees").
// It is the instruction; the user is told the fact in a toast and never this.
const DELEGATE_REMINDER =
  'zetetic-autopilot, owner rule 2026-10-15: implementation belongs to a subagent. This session\'s main loop just ran a ' +
  'tool that changes files or state; delegate implementation to a subagent (Agent tool) and keep this loop for orchestration.'

// Owner rule, 2026-10-15: no task runs in the global session, all is delegated. A call of the main loop
// that writes code or changes things is the work a subagent is for: a row each time, a toast to the user and a
// reminder to the model once a turn. It warns and never blocks: the call goes ahead. Answers whether the model
// is owed its reminder on this call's result, and for which turn.
async function nudgeMain($: EngineInterface, e: { tool: string }): Promise<{ turnId: string | null; remind: boolean }> {
  const turnId = (await read($, phases)).turnId
  const at = await $.clock.now()
  await update($, policy, (s) =>
    decide(s, { at, kind: 'work', subject: `main · ${e.tool}`, from: 'main loop', to: 'delegate to a subagent', applied: false }),
  )
  if (toastedTurn !== turnId) {
    toastedTurn = turnId
    $.ui.toast(`main ran ${e.tool} (owner rule 2026-10-15: implementation is a subagent's work)`)
  }
  const remind = remindedTurn !== turnId
  if (remind) remindedTurn = turnId

  return { turnId, remind }
}

// An Agent call is known to the spawn its tool raises by its tool_use_id, while the tool runs (effort.ts).
const onToolCall: Hook<'tool.call'> = async ($, e, next) => {
  const call = e as { tool: string; tool_use_id?: string; effort?: unknown }
  const id = call.tool === 'Agent' ? call.tool_use_id : undefined
  if (id === undefined) return toolCalled($, e, next)
  callStarted(id, call.effort)
  try {
    return await toolCalled($, e, next)
  } finally {
    callEnded(id)
  }
}

// The stuck signal: main's tool errors in a row, read by the next turn.step.
const toolCalled: Hook<'tool.call'> = async ($, e, next) => {
  const agentId = (e as { agentId?: string }).agentId
  const nudge = agentId === undefined && isMainImplementation(e.tool, e) ? await nudgeMain($, e) : undefined
  const ran = await next(e)
  const isBlocked = ran.deny !== undefined || ran.isError === true
  if (agentId === undefined) await update($, policy, (s) => ({ ...s, errorsInRow: isBlocked ? s.errorsInRow + 1 : 0 }))
  if (isBlocked) await update($, phases, (s) => erred(s, agentId ?? 'main'))
  if (nudge?.remind !== true) return ran
  // A refused call has no `context` to carry it: the reminder is still owed to the turn's next call.
  if (ran.deny !== undefined) {
    if (remindedTurn === nudge.turnId) remindedTurn = undefined
    return ran
  }

  // The result as core made it, whole (`ref` names its messages), with the reminder added to its context.
  return { ...ran, context: [...(ran.context ?? []), DELEGATE_REMINDER] }
}

// Memory offload (offload.ts, offloadrow.ts): a stream tool's result past the threshold is written whole to a
// file in the session's tool-results directory, which comes from the transcript path every classic SessionStart
// carries; the engine's retention sweeps it (`cleanupPeriodDays`, 30 days by default) and this mod deletes
// nothing. The stored row carries a preview, the path and the size; a result that cannot be written stays
// whole, and a row says why.
let transcriptPath: string | undefined

const onAppend: Hook<'session.append'> = async ($, e, next) => {
  const tool = e.origin.kind === 'tool' ? e.origin.tool : undefined
  if (tool === undefined || !OFFLOAD_TOOLS.has(tool)) return next(e)
  const p = await read($, policy)
  const sink: Sink = {
    note: (subject, reason) => note($, subject, reason),
    offloaded: async (plan, applied) => {
      const kept = plan.chars - plan.message.length
      const d: PolicyDecision = {
        at: await $.clock.now(),
        kind: 'offload',
        subject: tool,
        from: `${group(plan.chars)} chars`,
        to: `${plan.files[0]?.path} · about ${group(Math.round(kept / CHARS_PER_TOKEN))} tokens kept out of context`,
        applied,
      }
      await update($, policy, (s) => decide(s, d, applied ? kept : 0))
    },
  }
  const options = { thresholdChars: p.offloadThresholdChars, previewChars: p.offloadPreviewChars }
  const content = await offloadBlocks($, e.uuid, tool, e.message.content, { options, enforce: p.mode === 'enforce', transcriptPath, sink })

  return next(content === undefined ? e : { ...e, message: { ...e.message, content } })
}

// The stuck counter is a turn's own; main's ends with its turn.
const onComplete: Hook<'turn.complete'> = async ($, e, next) => {
  if (e.agentId === undefined) await update($, policy, (s) => ({ ...s, errorsInRow: 0 }))
  else ended(e.agentId)
  const at = await $.clock.now()
  await update($, phases, (s) => finished(s, e.agentId ?? 'main', at))

  return next(e)
}

// What a session starts from: no definition, phase or route known, this session's store key, the options
// checked, the configured fields set afresh (a hot reload keeps $.state from the previous load).
async function begin($: EngineInterface, mode: PolicyState['mode'], configured: (p: PolicyState) => PolicyState, capProblem?: string): Promise<void> {
  forgetDefinitions()
  resetGate()
  resetEfforts()
  mainTurnId = undefined
  toastedTurn = undefined
  remindedTurn = undefined
  await update($, phases, () => emptyPhases())
  await update($, spawns, () => [])
  await openRoutes($, (subject, reason) => note($, subject, reason))
  await checkConfig($, mode, (subject, reason) => note($, subject, reason))
  await update($, policy, configured)
  if (capProblem !== undefined) await note($, 'agent cap option', capProblem)
  await refreshContext($)
}

export const register: Register = (on, options) => {
  const mode: PolicyState['mode'] = options.policy_mode === 'enforce' ? 'enforce' : 'observe'
  const quotaPercent = Number(options.quota_pressure_percent ?? 80)
  const offload = offloadOptions(options.offload_threshold_chars, options.offload_preview_chars)
  const cap = maxParallelOption(options.max_parallel_agents)
  configureGate(cap.max)
  // A hot reload keeps $.state from the previous load: the configured fields are set afresh.
  const configured = (p: PolicyState): PolicyState => ({
    ...p,
    mode,
    quotaPercent,
    offloadThresholdChars: offload.options.thresholdChars,
    offloadPreviewChars: offload.options.previewChars,
  })

  on('session.start', async ($, e, next) => {
    await begin($, mode, configured, cap.problem)

    return next(e)
  })

  // /clear, /resume and /branch reset $.state and never fire session.start again.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await begin($, mode, configured, cap.problem)

    return next(e)
  })

  // Every start, /clear, /resume and /branch included: the transcript names the tool-results directory.
  on('classic.SessionStart', async ($, e, next) => {
    transcriptPath = e.transcript_path
    for (const problem of offload.problems) await note($, 'offload option', problem)

    return next(e)
  })

  on('session.measure', onMeasure)
  on('turn.step', onStep)
  on('agent.spawn', onSpawn)
  on('tool.call', onToolCall)
  on('session.append', { door: 'tool-result' }, onAppend)
  on('turn.complete', onComplete)
}
