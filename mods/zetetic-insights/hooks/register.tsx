import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import type { AgentRecord, Calibration, Design, InsightsState, TurnRecord } from '../types'
import { briefOf, mechanicalShare } from './brief'
import { pendingSessions, sessionSummary } from './consumer'
import { delegationStats, emptyDelegations, parseDesign } from './delegations'
import {
  CALIBRATION_PATH,
  FACETS_DIR,
  FACET_SESSIONS_CAP,
  GOALS_DIR,
  LEDGER_KEY,
  type Outcome,
  advisorStats,
  agentStats,
  applied,
  emptyCalibration,
  goalStatus,
  offRung,
  outcomeOf,
  parseCalibration,
  phaseStats,
  proposals,
  trimmed,
  withAgent,
} from './learn'
import { sessionModels } from './models'
import { placePath } from './paths'
import { trends } from './trend'

const insights = atom({ plugin: 'zetetic-insights', key: 'insights' } as const, {
  mode: 'observe',
  turns: 0,
  sessions: 0,
  judgedSessions: 0,
  ledgerError: null,
  facetsError: null,
  phases: [],
  trends: [],
  models: [],
  delegations: emptyDelegations(),
  mechanical: { sessions: 0, heavyReads: 0, heavySteps: 0, unmeasured: 0, share: null },
  brief: null,
  cortex: { pushed: 0, pending: 0, lastError: null, lastAt: null },
  agents: [],
  advisor: { heavyTurns: 0, heavyBeforeWrite: 0, heavyAtCompletion: 0, lightTurns: 0, lightWithAdvisor: 0 },
  goals: [],
  goalsError: null,
  calibration: emptyCalibration(),
  calibrationError: null,
  proposals: [],
  updatedAt: null,
} as InsightsState)

// The dependencies' state, as their contracts declare it; literals, as the validator lists them.
const AUTOPILOT_PHASES = { plugin: 'zetetic-autopilot', key: 'phases' } as const
const AUTOPILOT_POLICY = { plugin: 'zetetic-autopilot', key: 'policy' } as const
const GENIUS_STATE = { plugin: 'zetetic-genius', key: 'state' } as const

// Module state rebuilt at start: the ledger, the outcomes read, the agents finished in main's
// current turn before that turn completed.
let ledger: TurnRecord[] = []
let outcomes = new Map<string, Outcome>()
let pending: { agents: AgentRecord[]; dropped: number } = { agents: [], dropped: 0 }

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

// The handoff to Cortex. Sessions already handed over live in the store (it survives restarts;
// $.state is reset by /clear). A push never runs in a hook that ends the session (session.end has
// about 1.5 s in all, a Cortex remember was measured at 7.8 s): it is scheduled at start, for the
// sessions finished before this one.
export const PUSHED_KEY = 'pushed'
export const PUSHED_CAP = 500 // source: own choice, session ids kept as handed over; far more than the ledger holds (4 MiB, a few hundred sessions)
export const PUSH_BATCH = 5 // source: own choice, sessions handed over per start; a remember is slow (7.8 s measured 2026-10-14), the rest waits for the next start
export const PUSH_DELAY_MS = 30_000 // source: own choice, the wait after start before the first remember; the session's own startup work goes first
const REMEMBER_TAGS = ['archival', 'self-calibration', 'zetetic-insights'] // source: Cortex remember convention (agent-guidance: archival + agent_topic)

const REMEMBER_SOURCE = 'tool' // source: Cortex mcp_server/handlers/remember_schema.py lines 205-226 (ADR-0442), `source` is an enum (session, tool, user, consolidation, import, distillation); the writer is named by origin_tool

let server = 'plugin_hypermnesia-mcp_cortex' // source: cortex-cockpit plugin.json userConfig cortex_server default
let handed: string[] = []
let generation = 0
let pushing = false

const cortexOf = (pushed: number, pending: number, lastError: string | null, lastAt: number | null) => ({ pushed, pending, lastError, lastAt })

// The ids handed over, as the store kept them; absent or not a list (an older version) is empty.
// A store that cannot be read is an error, not empty: reading it as empty would remember twice.
async function loadHanded($: EngineInterface): Promise<string | null> {
  handed = []
  try {
    const raw = await $.store.get(PUSHED_KEY)
    if (Array.isArray(raw)) handed = raw.filter((x): x is string => typeof x === 'string').slice(-PUSHED_CAP)
    return null
  } catch (error) {
    return cut(error)
  }
}

async function setCortex($: EngineInterface, c: InsightsState['cortex']): Promise<void> {
  await update($, insights, (s) => ({ ...s, cortex: c }))
}

// Remembers the batch one session at a time. The first failure (a throw or an isError reply) stops
// the batch, is named in the state and leaves its session unpushed: the next start retries it.
async function pushBatch($: EngineInterface, mine: number, batch: string[]): Promise<void> {
  if (pushing || mine !== generation) return
  pushing = true
  try {
    for (const session of batch) {
      if (mine !== generation) return
      const content = sessionSummary(ledger, session)
      if (content === null || handed.includes(session)) continue
      let failure: string | null = null
      try {
        const r = await $.mcp.call(server, 'remember', { content, tags: REMEMBER_TAGS, agent_topic: 'self-calibration', source: REMEMBER_SOURCE, origin_tool: 'zetetic-insights' })
        if (r.isError) failure = r.content.map((b) => ('text' in b ? String(b.text) : '')).join(' ').trim() || 'remember returned an error'
      } catch (error) {
        failure = cut(error)
      }
      const at = await $.clock.now()
      if (failure === null) {
        handed = [...handed, session].slice(-PUSHED_CAP)
        try {
          await $.store.set(PUSHED_KEY, handed)
        } catch (error) {
          failure = `not saved: ${cut(error)}`
        }
      }
      const pending = pendingSessions(ledger, await $.session.id(), new Set(handed)).length
      await setCortex($, cortexOf(handed.length, pending, failure === null ? null : failure.slice(0, 120), at))
      if (failure !== null) return
    }
  } finally {
    pushing = false
  }
}

// After the ledger loads: names what is pending and schedules the first PUSH_BATCH of it.
async function schedulePush($: EngineInterface): Promise<void> {
  generation += 1
  const mine = generation
  const error = await loadHanded($)
  const todo = error === null ? pendingSessions(ledger, await $.session.id(), new Set(handed)) : []
  await setCortex($, cortexOf(handed.length, todo.length, error, null))
  if (todo.length > 0) $.clock.after(PUSH_DELAY_MS, () =>
      pushBatch($, mine, todo.slice(0, PUSH_BATCH)).catch((error) => setCortex($, cortexOf(handed.length, todo.length, cut(error), null))),
    )
}

const BRIEF_SECTION = 'zetetic-insights:self-calibration'

const cut = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 120)

async function expandHome($: EngineInterface, path: string): Promise<string> {
  if (!path.startsWith('~/')) return path
  const placed = placePath(
    { home: await $.env.get('HOME'), userProfile: await $.env.get('USERPROFILE'), configDir: await $.env.get('CLAUDE_CONFIG_DIR') },
    path,
  )
  if ('reason' in placed) throw new Error(placed.reason)

  return placed.path
}

// The ledger as the store kept it; a store that cannot be read, or holds something else under the
// key, is named and the session starts a new ledger (the next write replaces it).
async function loadLedger($: EngineInterface): Promise<string | null> {
  ledger = []
  try {
    const raw = await $.store.get(LEDGER_KEY)
    if (raw === undefined) return null
    if (!Array.isArray(raw)) return `the store's ${LEDGER_KEY} is not a list, a new ledger starts`
    ledger = trimmed(raw as TurnRecord[])
    return null
  } catch (error) {
    return cut(error)
  }
}

// The outcomes /insights wrote for the ledger's last sessions. No facets folder is "never run",
// not an error; an unreadable or malformed facet is skipped and named, the others are read.
async function loadOutcomes($: EngineInterface): Promise<string | null> {
  outcomes = new Map()
  const sessions = [...new Set(ledger.map((r) => r.session))].slice(-FACET_SESSIONS_CAP)
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

// Everything the panel shows, from the ledger and what was read beside it; enforced, a proposal
// the evidence supports is written at once.
async function recompute($: EngineInterface, extra: Partial<InsightsState> = {}): Promise<void> {
  const at = await $.clock.now()
  const s = { ...(await read($, insights)), ...extra }
  let calibration = s.calibration
  let phases = phaseStats(ledger, outcomes, calibration.changes)
  let ps = proposals(phases, calibration)
  if (s.mode === 'enforce' && ps.length > 0) {
    calibration = applied(calibration, ps, at)
    await writeCalibration($, calibration)
    phases = phaseStats(ledger, outcomes, calibration.changes)
    ps = []
  }
  await update($, insights, () => ({
    ...s,
    turns: ledger.length,
    sessions: new Set(ledger.map((r) => r.session)).size,
    judgedSessions: [...outcomes.values()].filter((o) => o !== 'unclear').length,
    phases,
    agents: agentStats(ledger),
    advisor: advisorStats(ledger),
    trends: trends(ledger, calibration.changes),
    models: sessionModels(ledger),
    delegations: delegationStats(ledger),
    mechanical: mechanicalShare(ledger),
    calibration,
    proposals: ps,
    updatedAt: at,
  }))
}

async function start($: EngineInterface, mode: InsightsState['mode']): Promise<void> {
  pending = { agents: [], dropped: 0 }
  recorded.clear()
  const ledgerError = await loadLedger($)
  const facetsError = await loadOutcomes($)
  const g = await readGoals($)
  const c = await readCalibration($)
  // The only place the brief is computed: recompute keeps it, so the system prompt stays the same
  // within a start. /resume and fork call start() again: the resumed session gets fresh evidence, at
  // the cost of one cache miss.
  const brief = briefOf(ledger)
  await recompute($, { mode, ledgerError, facetsError, goals: g.goals, goalsError: g.error, calibration: c.calibration, calibrationError: c.error, brief })
  await schedulePush($)
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
  const record: TurnRecord = {
    session: await $.session.id(),
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
  }
  pending = { agents: [], dropped: 0 }
  await saved($, [...ledger, record])
}

// The ledger kept under both caps, written; a store that still refuses it is named in the panel,
// never left to fail silently on every turn.
async function saved($: EngineInterface, next: TurnRecord[]): Promise<void> {
  ledger = trimmed(next)
  try {
    await $.store.set(LEDGER_KEY, ledger)
    await update($, insights, (s) => ({ ...s, ledgerError: null }))
  } catch (error) {
    await update($, insights, (s) => ({ ...s, ledgerError: `not saved: ${cut(error)}` }))
  }
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
  const last = ledger[ledger.length - 1]
  if (last === undefined || phases.turnId === null || last.turnId !== phases.turnId) {
    pending = withAgent(pending, agent)
    return
  }
  const joined = withAgent({ agents: last.agents, dropped: last.agentsDropped ?? 0 }, agent)
  const record = { ...last, agents: joined.agents, ...(joined.dropped > 0 ? { agentsDropped: joined.dropped } : {}) }
  await saved($, [...ledger.slice(0, -1), record])
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
    const c = applied(s.calibration, s.proposals, at)
    await writeCalibration($, c)
    await recompute($, { calibration: c, calibrationError: null })
    return `Applied: ${s.proposals.map((p) => `${p.phase} ${p.from} → ${p.to}`).join(', ')}.`
  }
  const now = Object.entries(s.calibration.phases).map(([p, e]) => `${p} ${e}`)
  const off = offRung(s.phases, s.calibration).map((o) => `${o.phase} ran ${o.ran.join(', ')} steps, none enough at ${o.now}`)
  return `Ledger: ${s.turns} turns over ${s.sessions} sessions, ${s.judgedSessions} judged by /insights. Calibration: ${now.length === 0 ? 'none (medium everywhere)' : now.join(', ')}. Proposals: ${
    s.proposals.length === 0 ? 'none' : s.proposals.map((p) => `${p.phase} ${p.from} → ${p.to} (${p.evidence})`).join('; ')
  }.${off.length === 0 ? '' : ` No proposal can come from: ${off.join('; ')}.`} /calibrate apply or /calibrate reset.`
}

export const register: Register = (on, options) => {
  const mode: InsightsState['mode'] = options.learning_mode === 'enforce' ? 'enforce' : 'observe'
  server = String(options.cortex_server ?? server)

  on('session.start', async ($, e, next) => {
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
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) await recordAgent($, e.agentId, e.usage)
    else {
      await recordTurn($)
      await recompute($)
    }

    return next(e)
  })

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
