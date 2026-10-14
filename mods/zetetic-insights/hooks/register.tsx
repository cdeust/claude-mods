import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRecord, Calibration, InsightsState, TurnRecord } from '../types'
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
    calibration,
    proposals: ps,
    updatedAt: at,
  }))
}

async function start($: EngineInterface, mode: InsightsState['mode']): Promise<void> {
  pending = { agents: [], dropped: 0 }
  const ledgerError = await loadLedger($)
  const facetsError = await loadOutcomes($)
  const g = await readGoals($)
  const c = await readCalibration($)
  await recompute($, { mode, ledgerError, facetsError, goals: g.goals, goalsError: g.error, calibration: c.calibration, calibrationError: c.error })
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
    main: main.runs.map((r) => ({ phase: r.phase, effort: r.effort, steps: r.steps, errors: r.errors })),
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
async function recordAgent($: EngineInterface, agentId: string): Promise<void> {
  const phases = (await $.state.get(AUTOPILOT_PHASES)).value
  const loop = phases?.loops.find((l) => l.id === agentId)
  if (phases === undefined || loop === undefined) return
  const agent: AgentRecord = {
    type: loop.type,
    phase: loop.phase,
    model: loop.model,
    steps: loop.runs.reduce((n, r) => n + r.steps, 0),
    errors: loop.runs.reduce((n, r) => n + r.errors, 0),
  }
  const last = ledger[ledger.length - 1]
  if (last === undefined || phases.turnId === null || last.turnId !== phases.turnId) {
    pending = withAgent(pending, agent)
    return
  }
  const joined = withAgent({ agents: last.agents, dropped: last.agentsDropped ?? 0 }, agent)
  const record = { ...last, agents: joined.agents, ...(joined.dropped > 0 ? { agentsDropped: joined.dropped } : {}) }
  await saved($, [...ledger.slice(0, -1), record])
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
    if (e.agentId !== undefined) await recordAgent($, e.agentId)
    else {
      await recordTurn($)
      await recompute($)
    }

    return next(e)
  })

  on('command.run', { command: 'calibrate' }, async ($, e) => ({ text: await calibrate($, (e.args ?? '').trim()) }))
}
