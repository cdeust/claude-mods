// The ledger's layout in the mod's store, one key per owner; pure. `$.store` is ONE JSON file
// shared by every Claude process: writes to different keys merge, a read-modify-write of one shared
// key was not shown safe (claude-mods/.claude/evidence/store-concurrency-2026-10-14.md). So each
// process writes only keys it owns, and nothing reads, modifies and writes back a shared key.
// I1: turns:<s> and ended:<s> are written by the process of session s only. Another process writes
//   only pushed:<s> of the finished sessions an aggregate update covered and aggregate/claim:aggregate
//   (I3), legacy:<s> and an absent pushed:<s> in the migration (I5), and deletes the keys of ended
//   sessions (I2) and orphans.
// I2: a process deletes another session's keys only when that session has ended:<s> (register.tsx
//   saved states the one race left). Never a session without ended:, idle or crashed.
// I3: the aggregate is updated by at most one process per claim window (register.tsx claimAggregate).
// I4: the own write lands within LEDGER_BYTES, or is refused and named in ledgerError.
// I5: the migration is idempotent and writes no key an owner writes.
// The exception to I1, frictions:<s>: any process may write it, for any finished session whose ended:<s>
//   names a transcript. Its value is the pure function frictionsOf of that file (no clock, no writer
//   in it, a total order on its rows), so two processes writing at once write the same value. The
//   process of s deletes it when s resumes (its transcript grows again); eviction and orphans delete
//   it as the other keys of s.

import type { TurnRecord } from '../types'
import { type Friction, isUnavailable, rowsOf } from './friction'
import { LEDGER_BYTES, recordBytes, trimmed, utf8Bytes } from './learn'

export const TURNS = 'turns:' // that session's records; only the process whose session id it is writes it
export const LEGACY = 'legacy:' // that session's records moved from the legacy key; only the migration writes it
export const ENDED = 'ended:' // { at, transcript? }, set by that same process at classic.SessionEnd and session.end (also fired by /clear, old id); an older value has no transcript
export const CLAIM = 'claim:' // { by, at }, set by the process about to hand the session over, then read back
export const PUSHED = 'pushed:' // { at, lastAt }: that session is in the aggregate memory, up to its record lastAt
export const AGGREGATE = 'aggregate' // { at, memoryId? }: the head of the one aggregate memory in Cortex; claim:aggregate guards it
export const FRICTIONS = 'frictions:' // that session's frictions (friction.ts), measured from the transcript its ended: names; [] is measured, none found
export const SESSION_PREFIXES = [TURNS, LEGACY, ENDED, PUSHED, CLAIM, FRICTIONS] as const // a deleted session loses all six, records first
export const LEGACY_TURNS = 'turns' // the single-key ledger of 0.5-0.6 (PR #13), every process rewriting it whole
export const LEGACY_PUSHED = 'pushed' // the single-key handover list of PR #18 before this layout

export const CLAIM_TTL_MS = 10 * 60_000 // source: own choice, far above one batch (30 s delay, then 5 remembers at 7.8 s measured 2026-10-14); an older claim is a process that died mid-handover
export const FRICTION_BATCH = 3 // source: own choice, transcripts read per start; a transcript is megabytes, and the read is deferred (observer effect: the measure must not slow the session it measures)
export const STALE_MS = 24 * 3_600_000 // source: own choice, a session with no turn for a day is finished for the handover: covers a crashed process that never fired session.end

export type Claim = { by: string; at: number }
export type Aggregate = { at: number; memoryId?: number }
export const aggregateOf = (v: unknown): Aggregate => {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  const id = o.memoryId
  return { at: typeof o.at === 'number' ? o.at : 0, ...(Number.isSafeInteger(id) && (id as number) > 0 ? { memoryId: id as number } : {}) }
}
// What a handover recorded: when, and the newest record `at` it covered.
export type Pushed = { at: number; lastAt: number }

// A pushed: value without a numeric lastAt (the legacy { at: 0 }, or junk) is no handover: the
// session is sent again, delivery stays at least once.
export const pushedOf = (v: unknown): Pushed | undefined => {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  return typeof o.lastAt === 'number' && Number.isFinite(o.lastAt) ? { at: typeof o.at === 'number' ? o.at : 0, lastAt: o.lastAt } : undefined
}
export const isCovered = (p: Pushed | undefined, newest: number): boolean => p !== undefined && newest <= p.lastAt

export const keyOf = (prefix: string, session: string): string => `${prefix}${session}`
export const sessionOfKey = (key: string, prefix: string): string | null => (key.startsWith(prefix) && key.length > prefix.length ? key.slice(prefix.length) : null)

// What the store holds, by session: turns:<s> and legacy:<s> together, one record per turnId. A
// value of either that is not a list is listed in `malformed`.
export type Layout = {
  turns: ReadonlyMap<string, readonly TurnRecord[]>
  ended: ReadonlySet<string>
  // The transcript each ended session named at its end; a session whose ended: has none (an older
  // value, or classic hooks not run under managed settings) is not here: its frictions are not measured.
  transcripts: ReadonlyMap<string, string>
  frictions: ReadonlyMap<string, readonly Friction[]>
  pushed: ReadonlyMap<string, Pushed>
  claims: ReadonlyMap<string, Claim>
  malformed: readonly string[]
}

// Two record lists of one session as one, in time order, a turnId kept once.
export const unionOf = (a: readonly TurnRecord[], b: readonly TurnRecord[]): TurnRecord[] => {
  const seen = new Set(a.map((r) => r.turnId))
  return [...a, ...b.filter((r) => !seen.has(r.turnId))].sort((x, y) => x.at - y.at)
}

const isClaim = (v: unknown): v is Claim => typeof v === 'object' && v !== null && typeof (v as Claim).by === 'string' && typeof (v as Claim).at === 'number'

export const layoutOf = (entries: ReadonlyMap<string, unknown>): Layout => {
  const turns = new Map<string, readonly TurnRecord[]>()
  const ended = new Set<string>()
  const transcripts = new Map<string, string>()
  const frictions = new Map<string, readonly Friction[]>()
  const pushed = new Map<string, Pushed>()
  const claims = new Map<string, Claim>()
  const malformed: string[] = []
  for (const [key, value] of entries) {
    const t = sessionOfKey(key, TURNS) ?? sessionOfKey(key, LEGACY)
    if (t !== null) {
      if (Array.isArray(value)) turns.set(t, unionOf(turns.get(t) ?? [], value as TurnRecord[]))
      else malformed.push(key)
      continue
    }
    const e = sessionOfKey(key, ENDED)
    if (e !== null) {
      ended.add(e)
      const t = (typeof value === 'object' && value !== null ? (value as { transcript?: unknown }).transcript : undefined)
      if (typeof t === 'string' && t !== '') transcripts.set(e, t)
    }
    const f = sessionOfKey(key, FRICTIONS)
    if (f !== null && (Array.isArray(value) || isUnavailable(value))) frictions.set(f, rowsOf(value)) // an unavailable marker is measured, with no rows
    const p = sessionOfKey(key, PUSHED)
    const covered = p === null ? undefined : pushedOf(value)
    if (p !== null && covered !== undefined) pushed.set(p, covered)
    const c = sessionOfKey(key, CLAIM)
    if (c !== null && isClaim(value)) claims.set(c, value)
  }
  return { turns, ended, transcripts, frictions, pushed, claims, malformed }
}

export const newestAt = (records: readonly TurnRecord[]): number => records.reduce((m, r) => Math.max(m, r.at), Number.NEGATIVE_INFINITY)

// Finished for the handover (never for eviction, I2): its process said so at session.end, or it has
// had no turn for STALE_MS.
export const isFinished = (session: string, ended: ReadonlySet<string>, newest: number, now: number): boolean => ended.has(session) || now - newest >= STALE_MS

export const claimedByOther = (claim: Claim | undefined, own: string, now: number): boolean => claim !== undefined && claim.by !== own && now - claim.at < CLAIM_TTL_MS

// The handover (I3): the finished sessions other than the own one, oldest first, and those of
// them whose pushed: does not cover their newest record. The aggregate needs an update when that
// second list is not empty; every finished session is in its text (register.tsx).
export const handoverPlan = (layout: Layout, own: string, now: number): { finished: string[]; pending: string[] } => {
  const finished = [...layout.turns.entries()]
    .map(([session, records]) => ({ session, newest: newestAt(records) }))
    .filter((s) => s.session !== own && isFinished(s.session, layout.ended, s.newest, now))
    .sort((a, b) => a.newest - b.newest)
  return { finished: finished.map((s) => s.session), pending: finished.filter((s) => !isCovered(layout.pushed.get(s.session), s.newest)).map((s) => s.session) }
}

// A records key's bytes in the store file: its records as recordBytes measures them (two levels
// deep, as under the legacy key), plus the key's own line.
export const keyBytes = (key: string, records: readonly TurnRecord[]): number => utf8Bytes(JSON.stringify(key)) + 8 + records.reduce((n, r) => n + recordBytes(r), 0)

export type Sized = { session: string; bytes: number; newest: number; ended: boolean; pushed: boolean }

// I4 and I2: the ended sessions the own write deletes, pushed (every record covered) first then
// unpushed, each oldest first, until everything fits. A session without ended: is never chosen.
// null: even with every ended session gone the own write does not fit, so it is refused and nothing
// is deleted. An unpushed session evicted here is never handed to Cortex: its records are gone.
export const evictions = (others: readonly Sized[], ownBytes: number, budget = LEDGER_BYTES): string[] | null => {
  let rest = others.reduce((n, s) => n + s.bytes, 0)
  const evict: string[] = []
  const candidates = others.filter((s) => s.ended).sort((a, b) => (a.pushed === b.pushed ? a.newest - b.newest : a.pushed ? -1 : 1))
  for (const s of candidates) {
    if (rest + ownBytes <= budget) break
    evict.push(s.session)
    rest -= s.bytes
  }
  return rest + ownBytes <= budget ? evict : null
}

// The own records within the budget alone (and the record count cap), oldest dropped.
export const ownWithin = (session: string, records: readonly TurnRecord[], room = LEDGER_BYTES): TurnRecord[] => trimmed(records, Math.max(0, room - keyBytes(keyOf(TURNS, session), []) + 1))

// ended:, pushed:, claim: and frictions: keys whose session has no records key (evicted while another
// process claimed, pushed or measured it): deleted at the next own write. Never the own session's, never claim:aggregate.
export const orphans = (keys: readonly string[], own: string): string[] => {
  const held = new Set(keys.map((k) => sessionOfKey(k, TURNS) ?? sessionOfKey(k, LEGACY)).filter((s): s is string => s !== null))
  return keys.filter((k) => {
    for (const p of [ENDED, PUSHED, CLAIM, FRICTIONS]) {
      const s = sessionOfKey(k, p)
      if (s !== null) return s !== own && s !== AGGREGATE && !held.has(s)
    }
    return false
  })
}

export type Migration = { sets: [string, unknown][]; deletes: string[]; malformed: boolean }

// I5: legacy:<s> is a function of the legacy key alone, and no owner writes that family, so two
// processes migrating at once, before or after an owner's write to turns:<s>, write the same value
// beside it (I1 holds strictly). pushed:<s> is written only when absent: lastAt is the newest record
// of s under the legacy key or turns:<s>; with no record, nothing. A second run finds nothing left.
// The legacy ledger is trimmed as the old loader did on every load: what moves is what it kept.
export const migrationPlan = (legacyTurns: unknown, legacyPushed: unknown, present: ReadonlySet<string>, held: (session: string) => readonly TurnRecord[] | undefined): Migration => {
  const sets: [string, unknown][] = []
  const deletes: string[] = []
  const records = Array.isArray(legacyTurns) ? trimmed(legacyTurns as TurnRecord[]) : []
  const bySession = new Map<string, TurnRecord[]>()
  for (const r of records) bySession.set(r.session, [...(bySession.get(r.session) ?? []), r])
  for (const [session, own] of bySession) if (!present.has(keyOf(LEGACY, session))) sets.push([keyOf(LEGACY, session), own])
  const ids = Array.isArray(legacyPushed) ? legacyPushed.filter((x): x is string => typeof x === 'string') : []
  for (const id of new Set(ids)) {
    const newest = newestAt([...(bySession.get(id) ?? []), ...(held(id) ?? [])])
    if (present.has(keyOf(PUSHED, id)) || !Number.isFinite(newest)) continue
    sets.push([keyOf(PUSHED, id), { at: 0, lastAt: newest } satisfies Pushed])
  }
  if (legacyTurns !== undefined) deletes.push(LEGACY_TURNS)
  if (legacyPushed !== undefined) deletes.push(LEGACY_PUSHED)
  return { sets, deletes, malformed: legacyTurns !== undefined && !Array.isArray(legacyTurns) }
}

// The sessions of the brief's window to measure, newest first, at most `batch`: ended with a
// transcript named, no frictions: yet, not the own session. Without a transcript nothing is measured.
export const frictionTargets = (layout: Layout, window: ReadonlySet<string>, own: string, batch = FRICTION_BATCH): { session: string; transcript: string }[] =>
  [...layout.transcripts]
    .filter(([session]) => session !== own && window.has(session) && !layout.frictions.has(session))
    .map(([session, transcript]) => ({ session, transcript, newest: newestAt(layout.turns.get(session) ?? []) }))
    .sort((a, b) => b.newest - a.newest || (a.session < b.session ? -1 : 1))
    .slice(0, batch)
    .map(({ session, transcript }) => ({ session, transcript }))

// What ended:<s> holds: when, and the transcript (absent in a value written before it was kept).
export const endedValue = (at: number, transcript: string | undefined): { at: number; transcript?: string } => (transcript === undefined || transcript === '' ? { at } : { at, transcript })
