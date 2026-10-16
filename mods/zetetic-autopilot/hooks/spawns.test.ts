import { expect, test } from 'claude-code/testing'

import type { SpawnRoute } from '../types'
import { CLIP, HARD_SESSIONS, KEEP_SESSIONS, LIVE_TTL_MS, ROUTES_PER_SESSION, STORE_BYTES, clipped, spawnsKey, staleSpawnKeys } from './spawns'

const NOW = 1_792_000_000_000
const DAY = 24 * 60 * 60 * 1000
const keyAt = (ageMs: number, id: string) => spawnsKey(NOW - ageMs, id)

test('a key sorts by start time, whatever the session id', () => {
  expect(spawnsKey(5, 'zzz') < spawnsKey(1_792_000_000_000, 'aaa')).toBe(true)
  expect(spawnsKey(1_792_000_000_000.9, 's')).toBe('spawns:1792000000000:s')
})

test('sessions older than the TTL go so that, with the new one, KEEP_SESSIONS remain; other keys are never named', () => {
  const keys = Array.from({ length: KEEP_SESSIONS + 3 }, (_, i) => keyAt((100 - i) * DAY, `s${i}`)) // 98..78 days old, oldest first
  const stale = staleSpawnKeys([...keys, 'turns:abc', 'aggregate'], NOW)
  expect(stale).toEqual(keys.slice(0, 4))
  expect(staleSpawnKeys(keys.slice(0, 5), NOW)).toEqual([])
  expect(staleSpawnKeys([], NOW)).toEqual([])
})

test('B1: a session younger than the TTL survives, beyond the newest KEEP_SESSIONS: it may still be running', () => {
  // The oldest of KEEP_SESSIONS + 10 keys started two days ago: all of them are live, none is deleted.
  const keys = Array.from({ length: KEEP_SESSIONS + 10 }, (_, i) => keyAt(2 * DAY - i * 1000, `live${i}`))
  expect(staleSpawnKeys(keys, NOW)).toEqual([])
  // The 31st session of the review: 30 newer ones, itself two days old (the old rule deleted it).
  const thirty = Array.from({ length: 30 }, (_, i) => keyAt(i * 1000, `n${i}`))
  const long = keyAt(2 * DAY, 'long-running')
  expect(staleSpawnKeys([long, ...thirty], NOW)).toEqual([])
})

test('B1: the TTL edge: a key just older than LIVE_TTL_MS is deleted, one just younger stays', () => {
  const fill = Array.from({ length: KEEP_SESSIONS }, (_, i) => keyAt(i * 1000, `n${i}`))
  const older = keyAt(LIVE_TTL_MS + 1, 'older')
  const younger = keyAt(LIVE_TTL_MS - 1, 'younger')
  expect(staleSpawnKeys([older, younger, ...fill], NOW)).toEqual([older])
})

test('past HARD_SESSIONS the oldest goes whatever its age, so the store stays bounded', () => {
  const keys = Array.from({ length: HARD_SESSIONS + 5 }, (_, i) => keyAt(HARD_SESSIONS * 1000 - i * 1000 + 60_000, `h${i}`))
  const stale = staleSpawnKeys(keys, NOW)
  expect(stale).toEqual([...keys].sort().slice(0, 6))
  expect(keys.length - stale.length).toBe(HARD_SESSIONS - 1)
})

// The documented bound: HARD_SESSIONS sessions of ROUTES_PER_SESSION routes, each at its longest, against
// the store's 4 MiB. The longest record: every clipped string at its ceiling, applied true.
test('the worst-case store is under half of the 4 MiB cap, and every string of a record is clipped', () => {
  const long = (n: number) => 'x'.repeat(n + 50)
  const worst = clipped({
    at: 1_792_000_000_000,
    agentId: long(CLIP.agentId),
    type: long(CLIP.type),
    requested: long(CLIP.model),
    definition: long(CLIP.model),
    decided: long(CLIP.model),
    ran: long(CLIP.model),
    reason: 'definition',
    applied: true,
  } satisfies SpawnRoute)
  expect(worst.agentId).toHaveLength(CLIP.agentId)
  expect(worst.type).toHaveLength(CLIP.type)
  expect(worst.ran).toHaveLength(CLIP.model)
  const record = JSON.stringify(worst).length
  const session = record * ROUTES_PER_SESSION + 2 + SESSION_KEY_BYTES
  const total = session * HARD_SESSIONS
  expect(total).toBeLessThan(STORE_BYTES / 2)
})

const SESSION_KEY_BYTES = 'spawns:1792000000000:'.length + 36 + 8 // key, a 36-character session id, JSON overhead
