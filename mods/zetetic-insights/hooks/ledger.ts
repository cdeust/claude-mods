// The ledger's layout in the mod's store, one key per owner; pure. `$.store` is ONE JSON file
// shared by every Claude process: writes to different keys merge, a read-modify-write of one shared
// key was not shown safe (claude-mods/.claude/evidence/store-concurrency-2026-10-14.md). So each
// process writes only keys it owns, and nothing reads, modifies and writes back a shared key.
// I1: a process writes turns:<own> and ended:<own> only, plus the claim:/pushed: of a finished
// session it hands over, the deletion of finished sessions under the budget (and of orphans), and
// the migration of the legacy keys.

import type { TurnRecord } from '../types'
import { LEDGER_BYTES, recordBytes, trimmed, utf8Bytes } from './learn'

export const TURNS = 'turns:' // that session's records; only the process whose session id it is writes it
export const ENDED = 'ended:' // { at }, set by that same process at session.end (also fired by /clear, old id)
export const CLAIM = 'claim:' // { by, at }, set by the process about to hand the session over, then read back
export const PUSHED = 'pushed:' // { at, lastAt, memoryId? }, set by that process once Cortex's remember succeeded
export const SESSION_PREFIXES = [TURNS, ENDED, PUSHED, CLAIM] as const // a deleted session loses all four, turns: first
export const LEGACY_TURNS = 'turns' // the single-key ledger of 0.5-0.6 (PR #13), every process rewriting it whole
export const LEGACY_PUSHED = 'pushed' // the single-key handover list of PR #18 before this layout

export const CLAIM_TTL_MS = 10 * 60_000 // source: own choice, far above one batch (30 s delay, then 5 remembers at 7.8 s measured 2026-10-14); an older claim is a process that died mid-handover
export const STALE_MS = 24 * 3_600_000 // source: own choice, a session with no turn for a day is finished: covers a crashed process that never fired session.end

export type Claim = { by: string; at: number }
// What a handover recorded: when, the newest record `at` it covered, and the Cortex memory it made.
export type Pushed = { at: number; lastAt?: number; memoryId?: number }

// The newest record a pushed: key covers. Written by this version, lastAt. Migrated from the legacy
// list, lastAt is the newest legacy record of that session (migrationPlan): everything up to the
// migration. Without lastAt (a key written before lastAt existed): its push time `at` when set, which
// is at or after every record it handed over; `at` 0 (time not kept) covers every record.
export const coveredUpTo = (p: Pushed): number => (typeof p.lastAt === 'number' ? p.lastAt : p.at > 0 ? p.at : Number.POSITIVE_INFINITY)
export const isCovered = (p: Pushed | undefined, newest: number): boolean => p !== undefined && newest <= coveredUpTo(p)

export const keyOf = (prefix: string, session: string): string => `${prefix}${session}`
export const sessionOfKey = (key: string, prefix: string): string | null => (key.startsWith(prefix) && key.length > prefix.length ? key.slice(prefix.length) : null)

// What the store holds, by session. A turns: value that is not a list is listed in `malformed`.
export type Layout = {
  turns: ReadonlyMap<string, readonly TurnRecord[]>
  ended: ReadonlySet<string>
  pushed: ReadonlyMap<string, Pushed>
  claims: ReadonlyMap<string, Claim>
  malformed: readonly string[]
}

// A pushed: value that is not the expected shape covers everything: nothing is sent twice for it.
export const pushedOf = (v: unknown): Pushed => {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  const at = typeof o.at === 'number' ? o.at : 0
  return { at, ...(typeof o.lastAt === 'number' ? { lastAt: o.lastAt } : {}), ...(Number.isSafeInteger(o.memoryId) && (o.memoryId as number) > 0 ? { memoryId: o.memoryId as number } : {}) }
}

const isClaim = (v: unknown): v is Claim => typeof v === 'object' && v !== null && typeof (v as Claim).by === 'string' && typeof (v as Claim).at === 'number'

export const layoutOf = (entries: ReadonlyMap<string, unknown>): Layout => {
  const turns = new Map<string, readonly TurnRecord[]>()
  const ended = new Set<string>()
  const pushed = new Map<string, Pushed>()
  const claims = new Map<string, Claim>()
  const malformed: string[] = []
  for (const [key, value] of entries) {
    const t = sessionOfKey(key, TURNS)
    if (t !== null) {
      if (Array.isArray(value)) turns.set(t, value as TurnRecord[])
      else malformed.push(key)
      continue
    }
    const e = sessionOfKey(key, ENDED)
    if (e !== null) ended.add(e)
    const p = sessionOfKey(key, PUSHED)
    if (p !== null) pushed.set(p, pushedOf(value))
    const c = sessionOfKey(key, CLAIM)
    if (c !== null && isClaim(value)) claims.set(c, value)
  }
  return { turns, ended, pushed, claims, malformed }
}

export const newestAt = (records: readonly TurnRecord[]): number => records.reduce((m, r) => Math.max(m, r.at), Number.NEGATIVE_INFINITY)

// Finished: its process said so at session.end, or it has had no turn for STALE_MS.
export const isFinished = (session: string, ended: ReadonlySet<string>, newest: number, now: number): boolean => ended.has(session) || now - newest >= STALE_MS

export const claimedByOther = (claim: Claim | undefined, own: string, now: number): boolean => claim !== undefined && claim.by !== own && now - claim.at < CLAIM_TTL_MS

// Handed over only when finished, never the own session (live), never one claimed by another process
// within the TTL, and only when it holds a record newer than its pushed: covers (a session resumed
// after its handover is pending again, register.tsx re-sends it superseding its memory). Oldest
// first. I3, the claim protocol that makes it at most once, is stated at register.tsx schedulePush.
export const pendingSessions = (layout: Layout, own: string, now: number, hasSummary: (records: readonly TurnRecord[], session: string) => boolean): string[] =>
  [...layout.turns.entries()]
    .map(([session, records]) => ({ session, records, newest: newestAt(records) }))
    .filter(
      (s) =>
        s.session !== own &&
        isFinished(s.session, layout.ended, s.newest, now) &&
        !isCovered(layout.pushed.get(s.session), s.newest) &&
        !claimedByOther(layout.claims.get(s.session), own, now) &&
        hasSummary(s.records, s.session),
    )
    .sort((a, b) => a.newest - b.newest)
    .map((s) => s.session)

// A turns:<sid> key's bytes in the store file: its records as recordBytes measures them (two levels
// deep, as under the legacy key), plus the key's own line.
export const keyBytes = (session: string, records: readonly TurnRecord[]): number =>
  utf8Bytes(JSON.stringify(keyOf(TURNS, session))) + 8 + records.reduce((n, r) => n + recordBytes(r), 0)

export type Sized = { session: string; bytes: number; newest: number; finished: boolean; pushed: boolean }

// I4 and I2: the finished sessions the own write deletes, pushed first then unpushed, each oldest
// first, until everything fits; then the room left for the own key, whose oldest records go when the
// live sessions alone leave too little. A live session is never chosen. An unpushed session evicted
// here is never handed to Cortex: its records are gone.
export const evictions = (others: readonly Sized[], ownBytes: number, budget = LEDGER_BYTES): { evict: string[]; ownRoom: number } => {
  let rest = others.reduce((n, s) => n + s.bytes, 0)
  const evict: string[] = []
  const candidates = others.filter((s) => s.finished).sort((a, b) => (a.pushed === b.pushed ? a.newest - b.newest : a.pushed ? -1 : 1))
  for (const s of candidates) {
    if (rest + ownBytes <= budget) break
    evict.push(s.session)
    rest -= s.bytes
  }
  return { evict, ownRoom: Math.max(0, budget - rest) }
}

// The own records kept within the room the budget leaves (and the record count cap), oldest dropped.
export const ownWithin = (session: string, records: readonly TurnRecord[], room: number): TurnRecord[] => trimmed(records, Math.max(0, room - keyBytes(session, []) + 1))

// ended:, pushed: and claim: keys whose session has no turns: key (evicted while another process
// claimed or pushed it): deleted at the next own write. Never the own session's.
export const orphans = (keys: readonly string[], own: string): string[] => {
  const held = new Set(keys.map((k) => sessionOfKey(k, TURNS)).filter((s): s is string => s !== null))
  return keys.filter((k) => {
    for (const p of [ENDED, PUSHED, CLAIM]) {
      const s = sessionOfKey(k, p)
      if (s !== null) return s !== own && !held.has(s)
    }
    return false
  })
}

export type Migration = { sets: [string, unknown][]; deletes: string[]; malformed: boolean }

// I5: every value is a function of the legacy values alone, so two processes migrating at once write
// the same thing, and a second run finds nothing left. A session that has its turns: key keeps it.
// The legacy ledger is trimmed as the old loader did on every load: what moves is what it kept. A
// pushed id whose session has no records is dropped (a pushed: key without turns: is an orphan).
export const migrationPlan = (legacyTurns: unknown, legacyPushed: unknown, present: ReadonlySet<string>): Migration => {
  const sets: [string, unknown][] = []
  const deletes: string[] = []
  const records = Array.isArray(legacyTurns) ? trimmed(legacyTurns as TurnRecord[]) : []
  const bySession = new Map<string, TurnRecord[]>()
  for (const r of records) {
    const group = bySession.get(r.session)
    if (group === undefined) bySession.set(r.session, [r])
    else group.push(r)
  }
  for (const [session, own] of bySession) if (!present.has(keyOf(TURNS, session))) sets.push([keyOf(TURNS, session), own])
  const ids = Array.isArray(legacyPushed) ? legacyPushed.filter((x): x is string => typeof x === 'string') : []
  for (const id of new Set(ids)) {
    const held = bySession.has(id) || present.has(keyOf(TURNS, id))
    if (!held || present.has(keyOf(PUSHED, id))) continue
    // Covers every legacy record of the session: what it held at the migration. A session whose
    // records are only under turns:<id> already gets no lastAt, and coveredUpTo reads at 0 as all.
    const own = bySession.get(id)
    sets.push([keyOf(PUSHED, id), own === undefined ? { at: 0 } : { at: 0, lastAt: newestAt(own) }])
  }
  if (legacyTurns !== undefined) deletes.push(LEGACY_TURNS)
  if (legacyPushed !== undefined) deletes.push(LEGACY_PUSHED)
  return { sets, deletes, malformed: legacyTurns !== undefined && !Array.isArray(legacyTurns) }
}
