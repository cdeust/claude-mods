import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import type { AgentRecord, Calibration, Design, InsightsState, TurnRecord } from '../types'
import { briefOf, mechanicalShare, windowOf, windowSessions } from './brief'
import { type RememberOutcome, aggregateSummary, rememberOutcome } from './consumer'
import { delegationStats, emptyDelegations, parseDesign } from './delegations'
import { FRICTION_MAX_BYTES, type Unavailable, frictionsOf, recurringOver } from './friction'
import {
  CALIBRATION_PATH,
  FACETS_DIR,
  FACET_SESSIONS_CAP,
  GOALS_DIR,
  LEDGER_CAP,
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
  withAgent,
} from './learn'
import {
  AGGREGATE,
  CLAIM,
  type Claim,
  ENDED,
  FRICTIONS,
  LEGACY,
  LEGACY_PUSHED,
  LEGACY_TURNS,
  type Layout,
  PUSHED,
  type Pushed,
  SESSION_PREFIXES,
  STALE_MS,
  type Sized,
  TRANSCRIPT,
  TURNS,
  aggregateOf,
  claimedByOther,
  evictions,
  frictionTargets,
  handoverPlan,
  isCovered,
  keyBytes,
  keyOf,
  layoutOf,
  migrationPlan,
  newestAt,
  orphans,
  ownWithin,
  pushedOf,
  sessionOfKey,
} from './ledger'
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
  frictions: [],
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

// Module state rebuilt at start, and again before the first write after a hot reload (register()
// runs again and resets it; session.start does not fire). The own session's records are written to
// its own key every turn; the other sessions' records are a snapshot read at start, so the brief and
// the pane see other live sessions as of start.
let ownSid: string | null = null
let own: TurnRecord[] = []
let others: TurnRecord[] = []
let layout: Layout | null = null
let outcomes = new Map<string, Outcome>()
let pending: { agents: AgentRecord[]; dropped: number } = { agents: [], dropped: 0 }
// The frictions that could not be measured at the last attempt, named; kept so a turn's save does not erase it.
let frictionError: string | null = null

// Every session's records in time order, the newest LEDGER_CAP, as the single-key ledger held them.
const ledger = (): TurnRecord[] => [...others, ...own].sort((a, b) => a.at - b.at).slice(-LEDGER_CAP)

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

// The handoff to Cortex: one aggregate memory over the finished sessions, replacing itself. What it
// covers lives in the store (it survives restarts; $.state is reset by /clear), one pushed:<sid> key
// per session, and its head in the key `aggregate`. An update never runs in a hook that ends the
// session (session.end has about 1.5 s in all, a Cortex remember was measured at 7.8 s): it is
// scheduled at start, for the sessions finished by then.
export const PUSH_DELAY_MS = 30_000 // source: own choice, the wait after start before the first remember; the session's own startup work goes first
const REMEMBER_TAGS = ['archival', 'self-calibration', 'zetetic-insights'] // source: Cortex remember convention (agent-guidance: archival + agent_topic)

// source: Cortex mcp_server/shared/write_class.py classify_write_class (source 'tool' already resolves to deliberate, ADR-0688) and mcp_server/core/write_gate.py determine_bypass (deliberate bypasses the write gate, ADR-0319): stated, not left to the default
const REMEMBER_WRITE_CLASS = 'deliberate'
const REMEMBER_SOURCE = 'tool' // source: Cortex mcp_server/handlers/remember_schema.py lines 205-226 (ADR-0442), `source` is an enum (session, tool, user, consolidation, import, distillation); the writer is named by origin_tool

let server = 'plugin_hypermnesia-mcp_cortex' // source: cortex-cockpit plugin.json userConfig cortex_server default
let generation = 0
let pushing = false

const cortexOf = (pushed: number, pending: number, lastError: string | null, lastAt: number | null) => ({ pushed, pending, lastError, lastAt })
const AGGREGATE_CLAIM = keyOf(CLAIM, AGGREGATE)

async function setCortex($: EngineInterface, c: InsightsState['cortex']): Promise<void> {
  await update($, insights, (s) => ({ ...s, cortex: c }))
}

// The finished sessions marked as in the aggregate, each up to its newest record as read now.
async function cover($: EngineInterface, view: Layout, sessions: readonly string[], at: number): Promise<void> {
  for (const s of sessions) await $.store.set(keyOf(PUSHED, s), { at, lastAt: newestAt(view.turns.get(s) ?? []) } satisfies Pushed)
}

// What one reply changes (consumer.ts rememberOutcome), and what is named in state.cortex. A merged
// id is another memory, never recorded; a failure changes nothing and the next start retries.
async function applyOutcome($: EngineInterface, view: Layout, finished: readonly string[], outcome: RememberOutcome): Promise<string | null> {
  const at = await $.clock.now()
  if (outcome.kind === 'failed') return outcome.failure
  if (outcome.kind === 'merged') return `Cortex merged the aggregate into memory ${outcome.memoryId ?? '?'}, not ours: not recorded`
  if (outcome.kind === 'rejected') return `not stored, rejected by Cortex: ${outcome.reason}; retried at the next start`
  if (outcome.kind === 'cleared') {
    await $.store.set(AGGREGATE, { at }) // the head is only ever an id we created: a foreign one is never adopted
    return `${outcome.reason}: head cleared${outcome.foreignId === null ? '' : ` (Cortex named memory ${outcome.foreignId}, not ours)`}, the next start remembers a fresh head`
  }
  await $.store.set(AGGREGATE, { at, memoryId: outcome.memoryId })
  await cover($, view, finished, at)
  return null
}

// The aggregate updated once, after the delay: only while the claim is still exactly this one, over
// the store as read now (a session resumed during the delay is live again, and left out).
async function updateAggregate($: EngineInterface, mine: number, sid: string, claimAt: number): Promise<void> {
  if (pushing || mine !== generation) return
  pushing = true
  try {
    const claim = (await $.store.get(AGGREGATE_CLAIM)) as Claim | undefined
    if (claim?.by !== sid || claim.at !== claimAt) return
    const now = await $.clock.now()
    const view = await readLayout($, await $.store.keys())
    const plan = handoverPlan(view, sid, now)
    if (plan.pending.length === 0) return
    const content = aggregateSummary(plan.finished.flatMap((s) => view.turns.get(s) ?? []), now, view.frictions)
    let error: string | null = null
    if (content === null) await cover($, view, plan.finished, now) // nothing measured: nothing to say
    else {
      const head = aggregateOf(await $.store.get(AGGREGATE))
      const args = { content, tags: REMEMBER_TAGS, agent_topic: 'self-calibration', source: REMEMBER_SOURCE, origin_tool: 'zetetic-insights', write_class: REMEMBER_WRITE_CLASS, ...(head.memoryId === undefined ? {} : { supersedes_id: head.memoryId }) }
      let outcome: RememberOutcome
      try {
        outcome = rememberOutcome(await $.mcp.call(server, 'remember', args))
      } catch (error) {
        outcome = { kind: 'failed', failure: cut(error) }
      }
      error = await applyOutcome($, view, plan.finished, outcome)
    }
    const after = handoverPlan(await readLayout($, await $.store.keys()), sid, now)
    await setCortex($, cortexOf(after.finished.length - after.pending.length, after.pending.length, error?.slice(0, 120) ?? null, await $.clock.now()))
  } finally {
    pushing = false
  }
}

// I3, at most one process updates the aggregate per claim window. claim:aggregate is re-read from the
// store just before it is written (never from the start snapshot), skipped when another process holds
// it within CLAIM_TTL_MS, written, then read back after PUSH_DELAY_MS: only a claim still exactly its
// own goes on. Two processes both reach their remember only when one stalled PUSH_DELAY_MS (30 s) or
// more between its re-read and its write: otherwise the later write lands within 30 s of the
// earlier one, so the earlier one reads it back and skips, or the later one re-read the earlier
// claim and never wrote.
async function claimAggregate($: EngineInterface, sid: string, now: number): Promise<boolean> {
  if (claimedByOther((await $.store.get(AGGREGATE_CLAIM)) as Claim | undefined, sid, now)) return false
  await $.store.set(AGGREGATE_CLAIM, { by: sid, at: now } satisfies Claim)
  return true
}

// The deferred work of one start, in this order: the frictions of the finished sessions are measured
// first, so the aggregate (when this process holds its claim) says what they found. Neither runs in a
// hook; each names its own failure and never stops the other.
async function afterDelay($: EngineInterface, mine: number, sid: string, claimAt: number, claimed: boolean, counts: { pushed: number; pending: number }): Promise<void> {
  await measureFrictions($, mine, sid)
  if (!claimed) return
  await updateAggregate($, mine, sid, claimAt).catch((error) => setCortex($, cortexOf(counts.pushed, counts.pending, cut(error), null)))
}

// Exactly once per change holds when no process stalls PUSH_DELAY_MS between its claim re-read and
// write, an update ends within CLAIM_TTL_MS of its claim, and no process crashes between remember and
// its keys (then the next start repeats the remember: at least once). A throw here (the session id,
// the clock, the store, the state) is named in state.cortex and never fails start(); nothing the
// timer runs can leave a rejection unhandled.
async function schedulePush($: EngineInterface, loadError: string | null): Promise<void> {
  generation += 1
  const mine = generation
  try {
    const sid = await $.session.id()
    const now = await $.clock.now()
    const plan = layout === null ? { finished: [], pending: [] } : handoverPlan(layout, sid, now)
    const counts = { pushed: plan.finished.length - plan.pending.length, pending: plan.pending.length }
    await setCortex($, cortexOf(counts.pushed, counts.pending, layout === null ? (loadError ?? 'the ledger did not load') : null, null))
    const claimed = plan.pending.length > 0 && (await claimAggregate($, sid, now))
    const toMeasure = layout === null ? [] : frictionTargets(layout, windowSessions(windowOf(recordsOf(layout)).records), sid)
    if (!claimed && toMeasure.length === 0) return
    $.clock.after(PUSH_DELAY_MS, () => {
      afterDelay($, mine, sid, now, claimed, counts)
        .catch(() => undefined) // the state itself refused: there is nothing left to name it in
    })
  } catch (error) {
    try {
      await setCortex($, cortexOf(0, 0, `handover not scheduled: ${cut(error)}`.slice(0, 120), null))
    } catch {
      // the state itself refused: start() still completes, the next start schedules again
    }
  }
}

const BRIEF_SECTION = 'zetetic-insights:self-calibration'

const recordsOf = (view: Layout): TurnRecord[] => [...view.turns.values()].flat()
const FRICTION_NOT_MEASURED = 'frictions not measured'

// The frictions recurring over the sessions of the brief's window (the own, live one is not measured).
const recurringIn = (view: Layout | null, records: readonly TurnRecord[]): InsightsState['frictions'] =>
  view === null ? [] : recurringOver(view.frictions, [...windowSessions(windowOf(records).records)].filter((s) => s !== ownSid))

// Reads the transcripts of at most FRICTION_BATCH finished sessions of the window, each at most once:
// frictionsOf is a pure function of the file, so frictions:<s> holds the same value whichever process
// writes it (ledger.ts, the exception to I1). A transcript that cannot be read is named in the state
// and left unmarked, so the next start tries again. Only ever called from the deferred timer.
async function measureFrictions($: EngineInterface, mine: number, sid: string): Promise<void> {
  if (mine !== generation) return
  try {
    const view = await readLayout($, await $.store.keys())
    const failed: string[] = []
    const large: string[] = []
    for (const t of frictionTargets(view, windowSessions(windowOf(recordsOf(view)).records), sid)) {
      try {
        // The session may resume while its transcript is read (its process deletes ended: and the
        // frictions: it measured): nothing is written unless ended:<s> is exactly what it was when
        // the measurement began, so a resumed session is measured afresh when it ends again.
        const endedKey = keyOf(ENDED, t.session)
        const began = JSON.stringify(await $.store.get(endedKey)) ?? ''
        // The pre-check and the set are two awaits apart: a resume that runs entirely between them deletes ended: and
        // frictions:, and the set would then land stale. So after the set the ended: is read again, and if it is absent
        // or changed the frictions: just written is deleted. This bounds the stale window to the moments between the
        // set and that delete; the next resume deletion or the next measurement corrects it.
        const stillEnded = async (): Promise<boolean> => began !== '' && JSON.stringify(await $.store.get(endedKey)) === began
        const write = async (value: unknown): Promise<void> => {
          if (!(await stillEnded())) return
          await $.store.set(keyOf(FRICTIONS, t.session), value)
          if (!(await stillEnded())) await $.store.delete(keyOf(FRICTIONS, t.session))
        }
        if (!(await $.fs.exists(t.transcript))) await write({ unavailable: 'missing' } satisfies Unavailable) // gone for good: a fact, the same for every writer
        else {
          const { size } = await $.fs.stat(t.transcript)
          if (size > FRICTION_MAX_BYTES) {
            await write({ unavailable: 'too-large' } satisfies Unavailable)
            large.push(`${t.session.slice(0, 8)} ${size} bytes`)
          } else await write(frictionsOf(await $.fs.read(t.transcript)))
        }
      } catch (error) {
        failed.push(`${t.session.slice(0, 8)}: ${cut(error)}`)
      }
    }
    const named = [
      ...(failed.length === 0 ? [] : [`${FRICTION_NOT_MEASURED}, retried at the next start: ${failed.join('; ')}`]),
      ...(large.length === 0 ? [] : [`${FRICTION_NOT_MEASURED}, transcript over ${FRICTION_MAX_BYTES} bytes: ${large.join('; ')}`]),
    ]
    frictionError = named.length === 0 ? null : named.join(' | ').slice(0, 240)
    const after = await readLayout($, await $.store.keys())
    await update($, insights, (s) => ({
      ...s,
      frictions: recurringIn(after, recordsOf(after)),
      ledgerError: frictionError ?? (s.ledgerError?.startsWith(FRICTION_NOT_MEASURED) === true ? null : s.ledgerError),
    }))
  } catch (error) {
    frictionError = `${FRICTION_NOT_MEASURED}: ${cut(error)}`
    try {
      await update($, insights, (s) => ({ ...s, ledgerError: frictionError }))
    } catch {
      // the state itself refused: there is nothing left to name it in, and the aggregate must still run
    }
  }
}

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

// I5: the legacy single-key ledger and pushed list moved to legacy:<sid> and pushed:<sid>, then deleted.
async function migrate($: EngineInterface, keys: readonly string[]): Promise<string | null> {
  if (!keys.includes(LEGACY_TURNS) && !keys.includes(LEGACY_PUSHED)) return null
  const legacyPushed = await $.store.get(LEGACY_PUSHED)
  const held = new Map<string, TurnRecord[]>()
  for (const id of Array.isArray(legacyPushed) ? legacyPushed : []) {
    const raw = typeof id === 'string' ? await $.store.get(keyOf(TURNS, id)) : undefined
    if (Array.isArray(raw)) held.set(id as string, raw as TurnRecord[])
  }
  const plan = migrationPlan(await $.store.get(LEGACY_TURNS), legacyPushed, new Set(keys), (id) => held.get(id))
  for (const [key, value] of plan.sets) await $.store.set(key, value)
  for (const key of plan.deletes) await $.store.delete(key)
  return plan.malformed ? `the store's ${LEGACY_TURNS} was not a list, it was dropped` : null
}

async function readLayout($: EngineInterface, keys: readonly string[]): Promise<Layout> {
  const entries = new Map<string, unknown>()
  for (const key of keys) if (SESSION_PREFIXES.some((p) => sessionOfKey(key, p) !== null)) entries.set(key, await $.store.get(key))
  return layoutOf(entries)
}

// The ledger as the store keeps it, after the migration: the own session's records, and a snapshot
// of every other session's. A store that cannot be read is named and leaves the ledger unloaded, so
// no write replaces the own key from an empty copy. A resumed session is live again: its ended: goes.
async function loadLedger($: EngineInterface): Promise<string | null> {
  ownSid = null
  own = []
  others = []
  layout = null
  try {
    const sid = await $.session.id()
    const migrated = await migrate($, await $.store.keys())
    const view = await readLayout($, await $.store.keys())
    if (view.ended.has(sid)) await $.store.delete(keyOf(ENDED, sid))
    for (const prefix of [TRANSCRIPT, FRICTIONS]) if (view.transcripts.has(sid) || view.frictions.has(sid)) await $.store.delete(keyOf(prefix, sid)) // its transcript grows again: named and measured afresh when it ends
    own = [...(view.turns.get(sid) ?? [])]
    others = [...view.turns].filter(([s]) => s !== sid).flatMap(([, records]) => records)
    layout = view
    ownSid = sid
    const bad = view.malformed.length === 0 ? null : `${view.malformed.length} malformed, first ${view.malformed[0]}`
    return migrated ?? bad
  } catch (error) {
    return cut(error)
  }
}

// Before a write: the module holds the ledger of this session, or loads it (after a hot reload, or
// a session id that changed under it). A load that fails leaves the write undone and named.
async function loaded($: EngineInterface, sid: string): Promise<boolean> {
  if (ownSid === sid) return true
  const error = await loadLedger($)
  if (ownSid === sid) return true
  await update($, insights, (s) => ({ ...s, ledgerError: `not saved: ${error ?? 'the session id changed while loading'}` }))
  return false
}

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

// Everything the panel shows, from the ledger and what was read beside it; enforced, a proposal
// the evidence supports is written at once.
async function recompute($: EngineInterface, extra: Partial<InsightsState> = {}): Promise<void> {
  const at = await $.clock.now()
  const s = { ...(await read($, insights)), ...extra }
  const all = ledger()
  let calibration = s.calibration
  let phases = phaseStats(all, outcomes, calibration.changes)
  let ps = proposals(phases, calibration)
  if (s.mode === 'enforce' && ps.length > 0) {
    calibration = applied(calibration, ps, at)
    await writeCalibration($, calibration)
    phases = phaseStats(all, outcomes, calibration.changes)
    ps = []
  }
  await update($, insights, () => ({
    ...s,
    turns: all.length,
    sessions: new Set(all.map((r) => r.session)).size,
    judgedSessions: [...outcomes.values()].filter((o) => o !== 'unclear').length,
    phases,
    agents: agentStats(all),
    advisor: advisorStats(all),
    trends: trends(all, calibration.changes),
    models: sessionModels(all),
    delegations: delegationStats(all),
    mechanical: mechanicalShare(all),
    calibration,
    proposals: ps,
    updatedAt: at,
  }))
}

async function start($: EngineInterface, mode: InsightsState['mode']): Promise<void> {
  pending = { agents: [], dropped: 0 }
  recorded.clear()
  frictionError = null
  const ledgerError = await loadLedger($)
  const facetsError = await loadOutcomes($)
  const g = await readGoals($)
  const c = await readCalibration($)
  // The only place the brief is computed: recompute keeps it, so the system prompt stays the same
  // within a start. /resume and fork call start() again: the resumed session gets fresh evidence, at
  // the cost of one cache miss.
  const frictions = layout === null ? undefined : new Map([...layout.frictions].filter(([s]) => s !== ownSid))
  const brief = briefOf(ledger(), frictions)
  await recompute($, {
    mode,
    ledgerError,
    facetsError,
    goals: g.goals,
    goalsError: g.error,
    calibration: c.calibration,
    calibrationError: c.error,
    brief,
    frictions: recurringIn(layout, ledger()),
  })
  await schedulePush($, ledgerError)
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
  }
  pending = { agents: [], dropped: 0 }
  await saved($, sid, [...own, record])
}

// I4: the own records written under the byte budget, measured over every records key as read now.
// Ended sessions are evicted when the own write would not fit (ledger.ts evictions), then keys left
// without their session. A session without ended: is never deleted here (I2); when the own write
// cannot fit without that, it is refused and named in the panel, never left to fail silently.
// The one race left (I2): this process reads ended:S, then S's process resumes and deletes it, then
// this process evicts S, within the few store calls between that read and the deletes (milliseconds).
// S loses its stored records until its next own write rewrites turns:S from the module copy, which
// holds them all, except after a hot reload before S's first turn (the module copy is empty then).
async function saved($: EngineInterface, sid: string, next: TurnRecord[]): Promise<void> {
  try {
    const keys = await $.store.keys()
    const ended = new Set(keys.map((k) => sessionOfKey(k, ENDED)).filter((x): x is string => x !== null))
    const bySession = new Map<string, { bytes: number; records: TurnRecord[] }>()
    let ownLegacy = 0
    for (const key of keys) {
      const session = sessionOfKey(key, TURNS) ?? sessionOfKey(key, LEGACY)
      if (session === null) continue
      const raw = await $.store.get(key)
      if (!Array.isArray(raw)) continue
      if (session === sid) {
        if (key !== keyOf(TURNS, sid)) ownLegacy += keyBytes(key, raw as TurnRecord[]) // legacy:<own>, written by the migration only
        continue
      }
      const s = bySession.get(session) ?? { bytes: 0, records: [] }
      bySession.set(session, { bytes: s.bytes + keyBytes(key, raw as TurnRecord[]), records: [...s.records, ...(raw as TurnRecord[])] })
    }
    const sized: Sized[] = []
    for (const [session, s] of bySession) {
      const newest = newestAt(s.records)
      const covered = isCovered(pushedOf(await $.store.get(keyOf(PUSHED, session))), newest)
      sized.push({ session, bytes: s.bytes, newest, ended: ended.has(session), pushed: covered })
    }
    const mine = ownWithin(sid, next)
    const evict = evictions(sized, keyBytes(keyOf(TURNS, sid), mine) + ownLegacy)
    if (evict === null) throw new Error('the live sessions leave no room for this session within the ledger budget')
    for (const session of evict) for (const prefix of SESSION_PREFIXES) await $.store.delete(keyOf(prefix, session))
    for (const key of orphans(keys, sid)) await $.store.delete(key)
    if (evict.length > 0) others = others.filter((r) => !evict.includes(r.session))
    own = mine
    await $.store.set(keyOf(TURNS, sid), own)
    await update($, insights, (s) => ({ ...s, ledgerError: frictionError }))
  } catch (error) {
    await update($, insights, (s) => ({ ...s, ledgerError: `not saved: ${cut(error)}` }))
  }
}

// session.end, also fired with the old id by /clear: the session is finished and other processes may
// hand it over. One local set of ended:<sid> = { at }, well inside the hook's 1.5 s. Only a session
// with records is marked, so no ended: key outlives a session without a turns: key.
// classic.SessionEnd writes ONLY transcript:<sid> = { path } (the source of the session's frictions),
// by the same guard. The two hooks share no key, so nothing depends on which runs first, or on one
// not running: the measurement reads both keys. Classic hooks do not run under organisation-managed
// settings: then no transcript: key exists and the session's frictions are simply not measured.
const hasRecords = async ($: EngineInterface, sid: string): Promise<boolean> =>
  ownSid === sid ? own.length > 0 : (await $.store.get(keyOf(TURNS, sid))) !== undefined || (await $.store.get(keyOf(LEGACY, sid))) !== undefined

async function markEnded($: EngineInterface, sid: string): Promise<void> {
  try {
    if (await hasRecords($, sid)) await $.store.set(keyOf(ENDED, sid), { at: await $.clock.now() })
  } catch (error) {
    await update($, insights, (s) => ({ ...s, ledgerError: `not marked ended (finished after ${STALE_MS / 3_600_000} h idle instead): ${cut(error)}` }))
  }
}

async function markTranscript($: EngineInterface, sid: string, path: string): Promise<void> {
  try {
    if (path !== '' && (await hasRecords($, sid))) await $.store.set(keyOf(TRANSCRIPT, sid), { path })
  } catch (error) {
    await update($, insights, (s) => ({ ...s, ledgerError: `transcript not named (its frictions are not measured): ${cut(error)}` }))
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
  const sid = await $.session.id()
  if (!(await loaded($, sid))) return
  const last = own[own.length - 1]
  if (last === undefined || phases.turnId === null || last.turnId !== phases.turnId) {
    pending = withAgent(pending, agent)
    return
  }
  const joined = withAgent({ agents: last.agents, dropped: last.agentsDropped ?? 0 }, agent)
  const record = { ...last, agents: joined.agents, ...(joined.dropped > 0 ? { agentsDropped: joined.dropped } : {}) }
  await saved($, sid, [...own.slice(0, -1), record])
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
  ownSid = null // a load or a hot reload: the module holds no ledger until it reads the store again

  on('classic.SessionEnd', async ($, e, next) => {
    await markTranscript($, e.session_id, e.transcript_path)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    await markEnded($, e.sessionId)

    return next(e)
  }).catch(($, e, next) => next(e))

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
  }).catch(($, e, next) => next(e))

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
