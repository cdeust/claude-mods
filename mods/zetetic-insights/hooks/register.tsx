import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import type { AgentRecord, Calibration, Design, Finding, InsightsState, ProbeCount, ProbeReason, TurnRecord, Verdict } from '../types'
import { briefOf, mechanicalShare } from './brief'
import { delegationStats, parseDesign } from './delegations'
import { effectLine, effectsOf, movesWith } from './effect'
import { recurringIn, schedulePush, setServer } from './handover'
import {
  CALIBRATION_PATH,
  FACETS_DIR,
  FACET_SESSIONS_CAP,
  GOALS_DIR,
  type Outcome,
  advisorStats,
  agentStats,
  applied,
  emptyCalibration,
  goalStatus,
  outcomeOf,
  parseCalibration,
  withAgent,
} from './learn'
import { frictionsBySession } from './ledger'
import { sessionModels } from './models'
import { originStamp, observeCall, setOrigin, takeObserved } from './observe'
import { combineOutcomes } from './outcome'
import { type ProbeInfo, probesOf, withoutProbes } from './probes'
import { type Cell, cellsOf, decisions, phaseStats } from './rungs'
import { cut, expandHome, INITIAL } from './shared'
import { held, ledger, loadLedger, loaded, markEnded, markTranscript, note, saved } from './store-io'
import { trends } from './trend'
import type { BashResult } from './events'

const insights = atom({ plugin: 'zetetic-insights', key: 'insights' } as const, INITIAL)

// The dependencies' state, as their contracts declare it; literals, as the validator lists them.
const AUTOPILOT_PHASES = { plugin: 'zetetic-autopilot', key: 'phases' } as const
const AUTOPILOT_POLICY = { plugin: 'zetetic-autopilot', key: 'policy' } as const
const GENIUS_STATE = { plugin: 'zetetic-genius', key: 'state' } as const

// The ledger's insights state (shared.ts), written here: the turn records, the panel's statistics, the calibration.

// Module state beside the held ledger (store-io.ts): what recompute reads, rebuilt at start.
let outcomes = new Map<string, Outcome>()
let pending: { agents: AgentRecord[]; dropped: number } = { agents: [], dropped: 0 }
// Every session's probe decision, over the ledger as last computed (recompute).
let probes = new Map<string, ProbeInfo>()
// The outcome of each learning session and the runs of the learning sessions, as recompute last joined them (/calibrate apply freezes the moves from them).
let verdicts = new Map<string, Verdict>()
let runs: Cell[] = []

// The design each spawned agent was dispatched under, by agentId, kept for the agent's lifetime (a
// resumed agent completes more than one turn). Bounded: the oldest entry is dropped past the cap.
export const DESIGN_MAP_CAP = 200 // source: own choice, far above the agents running at once, small enough to hold in memory
const designs = new Map<string, Design | null>()
// The steps and failed calls already recorded per agentId, and the row they belong to (the since of
// its first run): loop.runs hold the agent's cumulative runs, a record keeps this turn's delta only.
// A row the autopilot evicted and reopened starts again from empty, so its baseline is 0. Same cap.
const recorded = new Map<string, { steps: number; errors: number; since: number | undefined }>()

const bounded = <V,>(map: Map<string, V>, key: string, value: V): void => {
  map.delete(key)
  map.set(key, value)
  while (map.size > DESIGN_MAP_CAP) {
    const oldest = map.keys().next()
    if (oldest.done === true) break
    map.delete(oldest.value)
  }
}

const remember = (agentId: string, design: Design | null): void => bounded(designs, agentId, design)

const BRIEF_SECTION = 'zetetic-insights:self-calibration'


// The outcomes /insights wrote for the ledger's last sessions. No facets folder is "never run",
// not an error; an unreadable or malformed facet is skipped and named, the others are read.
async function loadOutcomes($: EngineInterface): Promise<string | null> {
  outcomes = new Map()
  const sessions = [...new Set(ledger().map((r) => r.session))].slice(-FACET_SESSIONS_CAP)
  const failed: string[] = []
  let dir: string
  try {
    dir = await expandHome($, FACETS_DIR)
    if (!(await $.fs.exists(dir))) return null
  } catch (error) {
    return cut(error)
  }
  for (const session of sessions) {
    const path = `${dir}/${session}.json`
    try {
      if (await $.fs.exists(path)) outcomes.set(session, outcomeOf(await $.fs.read(path)))
    } catch (error) {
      failed.push(`${session}: ${cut(error)}`)
    }
  }
  return failed.length === 0 ? null : `${failed.length} skipped, first ${failed[0]}`.slice(0, 160)
}

async function readGoals($: EngineInterface): Promise<{ goals: InsightsState['goals']; error: string | null }> {
  try {
    const dir = `${await $.session.cwd()}/${GOALS_DIR}`
    if (!(await $.fs.exists(dir))) return { goals: [], error: null }
    const files = (await $.fs.list(dir)).filter((f) => f.kind === 'file' && f.name.endsWith('.md'))
    const goals = []
    for (const f of files) goals.push({ name: f.name.replace(/\.md$/, ''), status: goalStatus(await $.fs.read(`${dir}/${f.name}`)) })
    return { goals, error: null }
  } catch (error) {
    return { goals: [], error: cut(error) }
  }
}

async function readCalibration($: EngineInterface): Promise<{ calibration: Calibration; error: string | null }> {
  try {
    const path = await expandHome($, CALIBRATION_PATH)
    if (!(await $.fs.exists(path))) return { calibration: emptyCalibration(), error: null }
    return { calibration: parseCalibration(await $.fs.read(path)), error: null }
  } catch (error) {
    return { calibration: emptyCalibration(), error: cut(error) }
  }
}

async function writeCalibration($: EngineInterface, c: Calibration): Promise<void> {
  await $.fs.write(await expandHome($, CALIBRATION_PATH), `${JSON.stringify(c, null, 2)}\n`)
}

// What the learning sessions' runs say under a calibration: the rows, the proposals, what held the others
// back, and the measured effect of each applied move (the last move's credit gates undoing it).
function evidenceOf(calibration: Calibration) {
  const { effects, credits } = effectsOf(calibration.moves, runs, verdicts)
  const { proposals, findings } = decisions(runs, verdicts, calibration, credits)
  return { phases: phaseStats(runs, verdicts), proposals, findings, effects }
}

// Everything the panel shows, from the ledger and what was read beside it; enforced, a proposal
// the evidence supports is written at once.
async function recompute($: EngineInterface, extra: Partial<InsightsState> = {}): Promise<void> {
  const at = await $.clock.now()
  const s = { ...(await read($, insights)), ...extra }
  const every = ledger()
  // Probe sessions (hooks/probes.ts) are counted, never learned from: every statistic below reads `all`.
  probes = probesOf(every, held.layout?.transcripts)
  const all = withoutProbes(every, probes)
  const joined = combineOutcomes(all, outcomes)
  verdicts = joined.outcomes
  runs = cellsOf(all)
  let calibration = s.calibration
  let ev = evidenceOf(calibration)
  if (s.mode === 'enforce' && ev.proposals.length > 0) {
    calibration = applied(calibration, ev.proposals, at, movesWith(calibration, ev.proposals, at, runs, verdicts))
    await writeCalibration($, calibration)
    ev = { ...evidenceOf(calibration), proposals: [] }
  }
  await update($, insights, () => ({
    ...s,
    turns: all.length,
    sessions: new Set(all.map((r) => r.session)).size,
    judgedSessions: [...joined.outcomes.values()].filter((o) => o !== 'unclear').length,
    probes: probeCount(every, probes),
    outcomeSources: joined.sources,
    phases: ev.phases,
    findings: ev.findings,
    effects: ev.effects,
    agents: agentStats(all),
    advisor: advisorStats(all),
    trends: trends(all, calibration.changes),
    models: sessionModels(every, probes),
    delegations: delegationStats(all),
    mechanical: mechanicalShare(all),
    calibration,
    proposals: ev.proposals,
    updatedAt: at,
  }))
}

const probeCount = (records: readonly TurnRecord[], decided: ReadonlyMap<string, ProbeInfo>): ProbeCount => {
  const byReason: Record<ProbeReason, number> = { 'temp-cwd': 0, 'non-interactive-1-step': 0, 'one-step-unknown': 0 }
  let sessions = 0
  for (const info of decided.values()) {
    if (!info.probe || info.reason === null) continue
    sessions += 1
    byReason[info.reason] += 1
  }
  return { sessions, turns: records.filter((r) => decided.get(r.session)?.probe === true).length, byReason }
}

async function start($: EngineInterface, mode: InsightsState['mode']): Promise<void> {
  pending = { agents: [], dropped: 0 }
  recorded.clear()
  note.frictionError = null
  const ledgerError = await loadLedger($)
  const facetsError = await loadOutcomes($)
  const g = await readGoals($)
  const c = await readCalibration($)
  // The only place the brief is computed: recompute keeps it, so the system prompt stays the same
  // within a start. /resume and fork call start() again: the resumed session gets fresh evidence, at
  // the cost of one cache miss.
  const frictions = held.layout === null ? undefined : new Map([...frictionsBySession(held.layout)].filter(([s]) => s !== held.ownSid))
  const brief = briefOf(ledger(), frictions, probesOf(ledger(), held.layout?.transcripts))
  await recompute($, {
    mode,
    ledgerError,
    facetsError,
    goals: g.goals,
    goalsError: g.error,
    calibration: c.calibration,
    calibrationError: c.error,
    brief,
    frictions: recurringIn(held.layout, ledger(), held.ownSid),
  })
  await schedulePush($, held.layout, ledgerError)
}

// One main turn, as the autopilot's phases and policy and the genius grade left it.
async function recordTurn($: EngineInterface): Promise<void> {
  const phases = (await $.state.get(AUTOPILOT_PHASES)).value
  const main = phases?.loops.find((l) => l.id === 'main')
  if (phases === undefined || main === undefined || main.runs.length === 0) return
  const since = main.runs[0]?.since ?? 0
  const grade = (await $.state.get(GENIUS_STATE)).value?.classified
  const policy = (await $.state.get(AUTOPILOT_POLICY)).value
  const uses = phases.advisor.uses.filter((u) => u.turnId === phases.turnId)
  const sid = await $.session.id()
  if (!(await loaded($, sid))) return
  const seen = takeObserved()
  const record: TurnRecord = {
    session: sid,
    turnId: phases.turnId ?? '',
    at: await $.clock.now(),
    taskClass: grade !== null && grade !== undefined && grade.turnId === phases.turnId ? grade.taskClass : null,
    main: main.runs.map((r) => ({ phase: r.phase, effort: r.effort, steps: r.steps, errors: r.errors, ...(r.reads === undefined ? {} : { reads: r.reads }) })),
    mainModel: main.model,
    agents: pending.agents,
    ...(pending.dropped > 0 ? { agentsDropped: pending.dropped } : {}),
    advisor: {
      calls: uses.reduce((n, u) => n + u.calls, 0),
      beforeWrite: uses.filter((u) => u.when === 'before-write').reduce((n, u) => n + u.calls, 0),
      atCompletion: uses.filter((u) => u.when === 'at-completion').reduce((n, u) => n + u.calls, 0),
    },
    stuck: policy?.decisions.filter((d) => d.kind === 'stuck' && d.at >= since).length ?? 0,
    ...originStamp(),
    ...(seen.events.length > 0 ? { events: seen.events } : {}),
    ...(seen.eventsDropped > 0 ? { eventsDropped: seen.eventsDropped } : {}),
    frictions: seen.frictions,
  }
  pending = { agents: [], dropped: 0 }
  await saved($, sid, [...held.own, record])
}


// A finished agent goes to main's current turn. When that turn already completed (an agent that
// ran in the background past it), it joins that turn's record instead of the next turn's.
async function recordAgent($: EngineInterface, agentId: string, usage: TurnUsage | undefined): Promise<void> {
  const phases = (await $.state.get(AUTOPILOT_PHASES)).value
  const loop = phases?.loops.find((l) => l.id === agentId)
  if (phases === undefined || loop === undefined) return
  const since = loop.runs[0]?.since
  const total = { steps: loop.runs.reduce((n, r) => n + r.steps, 0), errors: loop.runs.reduce((n, r) => n + r.errors, 0) }
  const known = recorded.get(agentId)
  const before = known !== undefined && known.since === since ? known : { steps: 0, errors: 0 }
  bounded(recorded, agentId, { ...total, since })
  const agent: AgentRecord = {
    agentId,
    type: loop.type,
    phase: loop.phase,
    model: loop.model,
    steps: Math.max(0, total.steps - before.steps),
    errors: Math.max(0, total.errors - before.errors),
    // Absent when the spawn was never seen (a reload); null when it carried no DESIGN block.
    ...(designs.has(agentId) ? { design: designs.get(agentId) ?? null } : {}),
    ...(usage === undefined
      ? {}
      : { tokensIn: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens, tokensOut: usage.output_tokens }),
  }
  const sid = await $.session.id()
  if (!(await loaded($, sid))) return
  const last = held.own[held.own.length - 1]
  if (last === undefined || phases.turnId === null || last.turnId !== phases.turnId) {
    pending = withAgent(pending, agent)
    return
  }
  const joined = withAgent({ agents: last.agents, dropped: last.agentsDropped ?? 0 }, agent)
  const record = { ...last, agents: joined.agents, ...(joined.dropped > 0 ? { agentsDropped: joined.dropped } : {}) }
  await saved($, sid, [...held.own.slice(0, -1), record])
  await recompute($)
}


async function calibrate($: EngineInterface, args: string): Promise<string> {
  const s = await read($, insights)
  const at = await $.clock.now()
  if (args === 'reset') {
    await writeCalibration($, { ...emptyCalibration(), updatedAt: at })
    await recompute($, { calibration: emptyCalibration(), calibrationError: null })
    return 'Calibration reset: every phase runs its tool loop at the ladder default (medium).'
  }
  if (args === 'apply') {
    if (s.proposals.length === 0) return 'No proposal: the evidence supports no change yet.'
    const c = applied(s.calibration, s.proposals, at, movesWith(s.calibration, s.proposals, at, runs, verdicts))
    await writeCalibration($, c)
    await recompute($, { calibration: c, calibrationError: null })
    return `Applied: ${s.proposals.map((p) => `${p.phase} ${p.from} → ${p.to}`).join(', ')}.`
  }
  const now = Object.entries(s.calibration.phases).map(([p, e]) => `${p} ${e}`)
  return `Ledger: ${s.turns} turns over ${s.sessions} sessions (${s.probes.sessions} probe sessions kept out), ${s.judgedSessions} judged (${outcomeSourcesText(s)}). Calibration: ${now.length === 0 ? 'none (medium everywhere)' : now.join(', ')}. Proposals: ${
    s.proposals.length === 0 ? 'none' : s.proposals.map((p) => `${p.phase} ${p.from} → ${p.to} (${p.evidence})`).join('; ')
  }.${findingsText(s.findings)}${effectsText(s.effects)} /calibrate apply or /calibrate reset.`
}

const outcomeSourcesText = (s: InsightsState): string => `${s.outcomeSources.events} by events, ${s.outcomeSources.facets} by /insights, ${s.outcomeSources.disagree} disagreeing`
const findingsText = (fs: readonly Finding[]): string => (fs.length === 0 ? '' : ` No move: ${fs.map((f) => `${f.phase} at ${f.effort} (${f.kind}: ${f.note})`).join('; ')}.`)
const effectsText = (es: InsightsState['effects']): string => (es.length === 0 ? '' : ` Applied moves, measured: ${es.map(effectLine).join('; ')}.`)

type On = Parameters<Register>[0]

// Session lifecycle: the ledger is marked ended, loaded at start, reloaded after /clear, /resume and /branch.
function onSession(on: On, mode: InsightsState['mode']): void {
  on('classic.SessionEnd', async ($, e, next) => {
    await markTranscript($, e.session_id, e.transcript_path)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    await markEnded($, e.sessionId)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    setOrigin(e.isInteractive, e.cwd, [await $.env.get('TMPDIR'), await $.env.get('TEMP'), await $.env.get('TMP')])
    await start($, mode)
    try {
      await $.command.register({ name: 'calibrate', description: 'Show, apply or reset the per-phase effort the insights propose', argumentHint: 'apply|reset', immediate: true })
    } catch (error) {
      $.ui.toast(`/calibrate is taken by another plugin: ${cut(error).slice(0, 80)}`)
    }

    return next(e)
  })

  // /clear, /resume and /branch reset $.state and never fire session.start again.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await start($, mode)

    return next(e)
  }).catch(($, e, next) => next(e))
}

// The turn: its record at turn.complete, and what its tool calls showed.
function onTurn(on: On): void {
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) await recordAgent($, e.agentId, e.usage)
    else {
      await recordTurn($)
      await recompute($)
    }

    return next(e)
  })

  // Observer: the outcome events and the frictions the turn shows, from the calls themselves (no
  // transcript). The call's result is returned untouched; a failure to observe it is not the call's.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    try {
      await observeCall($, e as unknown as { tool: unknown; agentId?: string; command?: unknown }, ran as unknown as BashResult)
    } catch {
      // the observation failed: the turn simply shows fewer events, the call is unaffected
    }

    return ran
  })
}

// What the model reads and what the user types: the frozen brief, the spawn's design, /calibrate.
function onPrompt(on: On): void {
  // Appends the frozen self-calibration section last, on the session side of the cache boundary; the
  // engine's own sections are returned as they came. A state without a brief (older version, empty
  // ledger) adds nothing. The id is unique in a list: an existing one is replaced, never doubled.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const { brief } = await read($, insights)
    if (typeof brief !== 'string') return r
    const section = { id: BRIEF_SECTION, text: brief, scope: 'session' } as const

    return { ...r, sections: [...r.sections.filter((x) => x.id !== BRIEF_SECTION), section] }
  }).catch(($, e, next) => next(e))

  // Observes only: the result is the spawn's own, returned untouched; a throw here never blocks it.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId !== undefined) remember(r.agentId, parseDesign(e.prompt))

    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'calibrate' }, async ($, e) => ({ text: await calibrate($, (e.args ?? '').trim()) }))
}

export const register: Register = (on, options) => {
  const mode: InsightsState['mode'] = options.learning_mode === 'enforce' ? 'enforce' : 'observe'
  if (options.cortex_server !== undefined) setServer(String(options.cortex_server))
  held.ownSid = null // a load or a hot reload: the module holds no ledger until it reads the store again
  onSession(on, mode)
  onTurn(on)
  onPrompt(on)
}
