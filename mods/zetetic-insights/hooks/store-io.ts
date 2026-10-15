import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { TurnRecord } from '../types'
import { LEDGER_CAP } from './learn'
import {
  ENDED,
  FRICTIONS,
  LEGACY,
  LEGACY_PUSHED,
  LEGACY_TURNS,
  type Layout,
  PUSHED,
  SESSION_PREFIXES,
  STALE_MS,
  type Sized,
  TRANSCRIPT,
  TURNS,
  evictions,
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
import { cut, INITIAL } from './shared'

const insights = atom({ plugin: 'zetetic-insights', key: 'insights' } as const, INITIAL)

// The ledger this process holds and writes (ledger.ts invariants I1-I5): the own session's records, a
// snapshot of every other session's read at start, and the layout they came from. Rebuilt at start,
// and again before the first write after a hot reload (register() runs again and resets it).
export const held: { ownSid: string | null; own: TurnRecord[]; others: TurnRecord[]; layout: Layout | null } = { ownSid: null, own: [], others: [], layout: null }

// Every session's records in time order, the newest LEDGER_CAP, as the single-key ledger held them.
export const ledger = (): TurnRecord[] => [...held.others, ...held.own].sort((a, b) => a.at - b.at).slice(-LEDGER_CAP)

// Set by the handover module: the note of the frictions that could not be measured, kept so a turn's save does not erase it.
export const note: { frictionError: string | null } = { frictionError: null }

// I5: the legacy single-key ledger and pushed list moved to legacy:<sid> and pushed:<sid>, then deleted.
async function migrate($: EngineInterface, keys: readonly string[]): Promise<string | null> {
  if (!keys.includes(LEGACY_TURNS) && !keys.includes(LEGACY_PUSHED)) return null
  const legacyPushed = await $.store.get(LEGACY_PUSHED)
  const kept = new Map<string, TurnRecord[]>()
  for (const id of Array.isArray(legacyPushed) ? legacyPushed : []) {
    const raw = typeof id === 'string' ? await $.store.get(keyOf(TURNS, id)) : undefined
    if (Array.isArray(raw)) kept.set(id as string, raw as TurnRecord[])
  }
  const plan = migrationPlan(await $.store.get(LEGACY_TURNS), legacyPushed, new Set(keys), (id) => kept.get(id))
  for (const [key, value] of plan.sets) await $.store.set(key, value)
  for (const key of plan.deletes) await $.store.delete(key)
  return plan.malformed ? `the store's ${LEGACY_TURNS} was not a list, it was dropped` : null
}

export async function readLayout($: EngineInterface, keys: readonly string[]): Promise<Layout> {
  const entries = new Map<string, unknown>()
  for (const key of keys) if (SESSION_PREFIXES.some((p) => sessionOfKey(key, p) !== null)) entries.set(key, await $.store.get(key))
  return layoutOf(entries)
}

// The ledger as the store keeps it, after the migration: the own session's records, and a snapshot
// of every other session's. A store that cannot be read is named and leaves the ledger unloaded, so
// no write replaces the own key from an empty copy. A resumed session is live again: its ended: goes.
export async function loadLedger($: EngineInterface): Promise<string | null> {
  held.ownSid = null
  held.own = []
  held.others = []
  held.layout = null
  try {
    const sid = await $.session.id()
    const migrated = await migrate($, await $.store.keys())
    const view = await readLayout($, await $.store.keys())
    if (view.ended.has(sid)) await $.store.delete(keyOf(ENDED, sid))
    for (const prefix of [TRANSCRIPT, FRICTIONS]) if (view.transcripts.has(sid) || view.frictions.has(sid)) await $.store.delete(keyOf(prefix, sid)) // its transcript grows again: named and measured afresh when it ends
    held.own = [...(view.turns.get(sid) ?? [])]
    held.others = [...view.turns].filter(([s]) => s !== sid).flatMap(([, records]) => records)
    held.layout = view
    held.ownSid = sid
    const bad = view.malformed.length === 0 ? null : `${view.malformed.length} malformed, first ${view.malformed[0]}`
    return migrated ?? bad
  } catch (error) {
    return cut(error)
  }
}

// Before a write: the module holds the ledger of this session, or loads it (after a hot reload, or
// a session id that changed under it). A load that fails leaves the write undone and named.
export async function loaded($: EngineInterface, sid: string): Promise<boolean> {
  if (held.ownSid === sid) return true
  const error = await loadLedger($)
  if (held.ownSid === sid) return true
  await update($, insights, (s) => ({ ...s, ledgerError: `not saved: ${error ?? 'the session id changed while loading'}` }))
  return false
}


// I4: the own records written under the byte budget, measured over every records key as read now.
// Ended sessions are evicted when the own write would not fit (ledger.ts evictions), then keys left
// without their session. A session without ended: is never deleted here (I2); when the own write
// cannot fit without that, it is refused and named in the panel, never left to fail silently.
// The one race left (I2): this process reads ended:S, then S's process resumes and deletes it, then
// this process evicts S, within the few store calls between that read and the deletes (milliseconds).
// S loses its stored records until its next own write rewrites turns:S from the module copy, which
// holds them all, except after a hot reload before S's first turn (the module copy is empty then).
export async function saved($: EngineInterface, sid: string, next: TurnRecord[]): Promise<void> {
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
    if (evict.length > 0) held.others = held.others.filter((r) => !evict.includes(r.session))
    held.own = mine
    await $.store.set(keyOf(TURNS, sid), held.own)
    await update($, insights, (s) => ({ ...s, ledgerError: note.frictionError }))
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
async function hasRecords($: EngineInterface, sid: string): Promise<boolean> {
  if (held.ownSid === sid) return held.own.length > 0
  return (await $.store.get(keyOf(TURNS, sid))) !== undefined || (await $.store.get(keyOf(LEGACY, sid))) !== undefined
}

export async function markEnded($: EngineInterface, sid: string): Promise<void> {
  try {
    if (await hasRecords($, sid)) await $.store.set(keyOf(ENDED, sid), { at: await $.clock.now() })
  } catch (error) {
    await update($, insights, (s) => ({ ...s, ledgerError: `not marked ended (finished after ${STALE_MS / 3_600_000} h idle instead): ${cut(error)}` }))
  }
}

export async function markTranscript($: EngineInterface, sid: string, path: string): Promise<void> {
  try {
    if (path !== '' && (await hasRecords($, sid))) await $.store.set(keyOf(TRANSCRIPT, sid), { path })
  } catch (error) {
    await update($, insights, (s) => ({ ...s, ledgerError: `transcript not named (its frictions are not measured): ${cut(error)}` }))
  }
}

