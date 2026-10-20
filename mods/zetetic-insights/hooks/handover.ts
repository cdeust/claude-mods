import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { InsightsState, TurnRecord } from '../types'
import { windowOf, windowSessions } from './brief'
import { type RememberOutcome, aggregateSummary, rememberOutcome } from './consumer'
import { FRICTION_MAX_BYTES, type Unavailable, frictionsOf, recurringOver } from './friction'
import {
  AGGREGATE,
  CLAIM,
  type Claim,
  ENDED,
  FRICTIONS,
  type Layout,
  PUSHED,
  type Pushed,
  aggregateOf,
  claimedByOther,
  frictionTargets,
  frictionsBySession,
  handoverPlan,
  keyOf,
  newestAt,
} from './ledger'
import { probesOf, withoutProbes } from './probes'
import { cut, recordsOf, INITIAL } from './shared'
import { note, readLayout } from './store-io'

const insights = atom({ plugin: 'zetetic-insights', key: 'insights' } as const, INITIAL)

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

let server = 'plugin_hypermnesia-mcp_cortex' // source: mods/zetetic-insights/.claude-plugin/plugin.json userConfig cortex_server default
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
    const decided = probesOf(recordsOf(view), view.transcripts)
    const content = aggregateSummary(withoutProbes(plan.finished.flatMap((s) => view.turns.get(s) ?? []), decided), now, frictionsBySession(view))
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
type Deferred = { mine: number; sid: string; claimAt: number; claimed: boolean; counts: { pushed: number; pending: number } }

async function afterDelay($: EngineInterface, d: Deferred): Promise<void> {
  await measureFrictions($, d.mine, d.sid)
  if (!d.claimed) return
  await updateAggregate($, d.mine, d.sid, d.claimAt).catch((error) => setCortex($, cortexOf(d.counts.pushed, d.counts.pending, cut(error), null)))
}

// The Cortex server the aggregate is remembered to (the mod's cortex_server option).
export const setServer = (name: string): void => {
  server = name
}

// Exactly once per change holds when no process stalls PUSH_DELAY_MS between its claim re-read and
// write, an update ends within CLAIM_TTL_MS of its claim, and no process crashes between remember and
// its keys (then the next start repeats the remember: at least once). A throw here (the session id,
// the clock, the store, the state) is named in state.cortex and never fails start(); nothing the
// timer runs can leave a rejection unhandled.
export async function schedulePush($: EngineInterface, layout: Layout | null, loadError: string | null): Promise<void> {
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
      afterDelay($, { mine, sid, claimAt: now, claimed, counts })
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

const FRICTION_NOT_MEASURED = 'frictions not measured'

// The frictions recurring over the sessions of the brief's window (the own, live one is not measured).
export const recurringIn = (view: Layout | null, records: readonly TurnRecord[], ownSid: string | null): InsightsState['frictions'] =>
  view === null ? [] : recurringOver(frictionsBySession(view), [...windowSessions(windowOf(withoutProbes(records, probesOf(records, view.transcripts))).records)].filter((s) => s !== ownSid))

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
    note.frictionError = named.length === 0 ? null : named.join(' | ').slice(0, 240)
    const after = await readLayout($, await $.store.keys())
    await update($, insights, (s) => ({
      ...s,
      frictions: recurringIn(after, recordsOf(after), sid),
      ledgerError: note.frictionError ?? (s.ledgerError?.startsWith(FRICTION_NOT_MEASURED) === true ? null : s.ledgerError),
    }))
  } catch (error) {
    note.frictionError = `${FRICTION_NOT_MEASURED}: ${cut(error)}`
    try {
      await update($, insights, (s) => ({ ...s, ledgerError: note.frictionError }))
    } catch {
      // the state itself refused: there is nothing left to name it in, and the aggregate must still run
    }
  }
}
