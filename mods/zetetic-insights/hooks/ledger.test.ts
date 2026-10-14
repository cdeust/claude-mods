import { expect, test } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import { sessionSummary } from './consumer'
import {
  CLAIM_TTL_MS,
  LEGACY_PUSHED,
  LEGACY_TURNS,
  STALE_MS,
  type Sized,
  evictions,
  isCovered,
  isFinished,
  keyBytes,
  keyOf,
  layoutOf,
  migrationPlan,
  orphans,
  ownWithin,
  pendingSessions,
  pushedOf,
  sessionOfKey,
} from './ledger'

const NOW = 100 * STALE_MS
const hasSummaryOf = (records: readonly TurnRecord[], session: string): boolean => sessionSummary(records, session) !== null

const turn = (session: string, at: number, o: Partial<TurnRecord> = {}): TurnRecord => ({
  session,
  turnId: `${session}-${at}`,
  at,
  taskClass: null,
  mainModel: 'claude-opus-5-5',
  main: [{ phase: 'analysis', effort: 'medium', steps: 10, errors: 0, reads: 6 }],
  agents: [],
  advisor: { calls: 0, beforeWrite: 0, atCompletion: 0 },
  stuck: 0,
  ...o,
})

const view = (entries: Record<string, unknown>) => layoutOf(new Map(Object.entries(entries)))

test('keys: one per owner and prefix; the legacy keys are not session keys', () => {
  expect(keyOf('turns:', 'abc')).toBe('turns:abc')
  expect(sessionOfKey('turns:abc', 'turns:')).toBe('abc')
  expect(sessionOfKey(LEGACY_TURNS, 'turns:')).toBeNull()
  expect(sessionOfKey('turns:', 'turns:')).toBeNull()
  expect(sessionOfKey(LEGACY_PUSHED, 'pushed:')).toBeNull()
  const l = view({ 'turns:a': [turn('a', 1)], 'turns:bad': 'x', 'ended:a': { at: 2 }, 'pushed:b': { at: 3 }, 'claim:c': { by: 'z', at: 4 }, 'claim:d': 'junk', turns: [] })
  expect([...l.turns.keys()]).toEqual(['a'])
  expect(l.malformed).toEqual(['turns:bad'])
  expect([...l.ended]).toEqual(['a'])
  expect([...l.pushed]).toEqual([['b', { at: 3 }]])
  expect([...l.claims.keys()]).toEqual(['c'])
})

test('finished: ended, or no turn for STALE_MS (a crashed session); a fresh session without ended: is live', () => {
  expect(isFinished('a', new Set(['a']), NOW, NOW)).toBe(true)
  expect(isFinished('a', new Set(), NOW - STALE_MS, NOW)).toBe(true)
  expect(isFinished('a', new Set(), NOW - STALE_MS + 1, NOW)).toBe(false)
})

test('I3 pendingSessions: finished only, oldest first; never the own one, a pushed one, or one claimed by another within the TTL', () => {
  const l = view({
    'turns:own': [turn('own', NOW - 5)],
    'ended:own': { at: NOW },
    'turns:live': [turn('live', NOW - 10)],
    'turns:ended-new': [turn('ended-new', NOW - 20)],
    'ended:ended-new': { at: NOW - 19 },
    'turns:stale': [turn('stale', NOW - STALE_MS - 1)],
    'turns:pushed': [turn('pushed', NOW - 30)],
    'ended:pushed': { at: 1 },
    'pushed:pushed': { at: NOW, lastAt: NOW - 30 },
    'turns:resumed': [turn('resumed', NOW - 80), turn('resumed', NOW - 25)],
    'ended:resumed': { at: 1 },
    'pushed:resumed': { at: NOW - 70, lastAt: NOW - 80, memoryId: 7 },
    'turns:claimed': [turn('claimed', NOW - 40)],
    'ended:claimed': { at: 1 },
    'claim:claimed': { by: 'other', at: NOW - CLAIM_TTL_MS + 1 },
    'turns:expired': [turn('expired', NOW - 50)],
    'ended:expired': { at: 1 },
    'claim:expired': { by: 'other', at: NOW - CLAIM_TTL_MS },
    'turns:mine': [turn('mine', NOW - 60)],
    'ended:mine': { at: 1 },
    'claim:mine': { by: 'own', at: NOW },
    'turns:idle': [turn('idle', NOW - 70, { main: [] })],
    'ended:idle': { at: 1 },
  })
  expect(pendingSessions(l, 'own', NOW, hasSummaryOf)).toEqual(['stale', 'mine', 'expired', 'resumed', 'ended-new'])
})

const sized = (session: string, bytes: number, newest: number, finished: boolean, pushed: boolean): Sized => ({ session, bytes, newest, finished, pushed })

test('I4 I2 evictions: the oldest finished go, pushed before unpushed; a live session never; the own key is not a candidate', () => {
  const others = [
    sized('live-old', 100, 1, false, false),
    sized('unpushed-old', 100, 2, true, false),
    sized('pushed-new', 100, 9, true, true),
    sized('pushed-old', 100, 3, true, true),
    sized('unpushed-new', 100, 8, true, false),
  ]
  expect(evictions(others, 100, 600)).toEqual({ evict: [], ownRoom: 100 })
  expect(evictions(others, 100, 500)).toEqual({ evict: ['pushed-old'], ownRoom: 100 })
  expect(evictions(others, 100, 300)).toEqual({ evict: ['pushed-old', 'pushed-new', 'unpushed-old'], ownRoom: 100 })
  // Even with every finished session gone, the live one stays: the own key gets what is left.
  expect(evictions(others, 500, 300)).toEqual({ evict: ['pushed-old', 'pushed-new', 'unpushed-old', 'unpushed-new'], ownRoom: 200 })
})

test('I4 ownWithin: the own records fit the room left, oldest dropped, and keyBytes counts what is kept', () => {
  const records = Array.from({ length: 10 }, (_, i) => turn('own', i))
  const room = keyBytes('own', records.slice(4))
  const kept = ownWithin('own', records, room)
  expect(kept).toEqual(records.slice(4))
  expect(keyBytes('own', kept)).toBeLessThanOrEqual(room)
  expect(ownWithin('own', records, 0)).toEqual([])
})

test('orphans: ended/pushed/claim keys whose session has no turns: key, never the own one', () => {
  const keys = ['turns:a', 'ended:a', 'pushed:a', 'claim:gone', 'pushed:gone', 'ended:own', 'turns', 'claim:a']
  expect(orphans(keys, 'own')).toEqual(['claim:gone', 'pushed:gone'])
})

// A store as a plain object; a plan applied to it the way register.tsx migrate() applies it.
const applied = (store: Record<string, unknown>, plan: ReturnType<typeof migrationPlan>): Record<string, unknown> => {
  const next = { ...store }
  for (const [k, v] of plan.sets) next[k] = JSON.parse(JSON.stringify(v))
  for (const k of plan.deletes) delete next[k]
  return next
}
const planOf = (store: Record<string, unknown>) => migrationPlan(store[LEGACY_TURNS], store[LEGACY_PUSHED], new Set(Object.keys(store)))

test('I5 migration: legacy turns and pushed move per session; twice equals once; two processes at once equal once', () => {
  const legacy = {
    turns: [turn('a', 1), turn('b', 2), turn('a', 3)],
    pushed: ['a', 'gone', 'a'],
    'turns:b': [turn('b', 2), turn('b', 4)],
  }
  const once = applied(legacy, planOf(legacy))
  expect(once).toEqual({ 'turns:a': [turn('a', 1), turn('a', 3)], 'turns:b': [turn('b', 2), turn('b', 4)], 'pushed:a': { at: 0, lastAt: 3 } })
  expect(applied(once, planOf(once))).toEqual(once)
  // Both processes planned from the same store before either wrote: the same values land twice.
  const p = planOf(legacy)
  expect(applied(applied(legacy, p), p)).toEqual(once)
  expect(planOf(once)).toEqual({ sets: [], deletes: [], malformed: false })
})

test('I5 migration: a legacy ledger is trimmed as the old loader kept it; a non-list is dropped and named', () => {
  const many = Array.from({ length: 3005 }, (_, i) => turn('s', i))
  const plan = migrationPlan(many, undefined, new Set([LEGACY_TURNS]))
  expect((plan.sets[0]?.[1] as TurnRecord[]).length).toBe(3000)
  expect((plan.sets[0]?.[1] as TurnRecord[])[0]?.at).toBe(5)
  expect(migrationPlan('garbage', 'garbage', new Set())).toEqual({ sets: [], deletes: [LEGACY_TURNS, LEGACY_PUSHED], malformed: true })
})

test('coverage: lastAt when written; else the push time; at 0 without lastAt (time not kept) covers every record', () => {
  expect(isCovered(undefined, 5)).toBe(false)
  expect(isCovered({ at: 100, lastAt: 5 }, 5)).toBe(true)
  expect(isCovered({ at: 100, lastAt: 5 }, 6)).toBe(false)
  expect(isCovered({ at: 100 }, 100)).toBe(true)
  expect(isCovered({ at: 100 }, 101)).toBe(false)
  expect(isCovered({ at: 0 }, Number.MAX_SAFE_INTEGER)).toBe(true)
  expect(pushedOf('junk')).toEqual({ at: 0 })
  expect(pushedOf({ at: 1, lastAt: 2, memoryId: 3.5 })).toEqual({ at: 1, lastAt: 2 })
})
