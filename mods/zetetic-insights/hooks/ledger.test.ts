import { expect, test } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import {
  CLAIM_TTL_MS,
  FRICTIONS,
  FRICTION_BATCH,
  SESSION_PREFIXES,
  LEGACY_PUSHED,
  LEGACY_TURNS,
  STALE_MS,
  type Sized,
  evictions,
  frictionTargets,
  frictionsBySession,
  isCovered,
  isFinished,
  keyBytes,
  keyOf,
  layoutOf,
  migrationPlan,
  orphans,
  ownWithin,
  handoverPlan,
  pushedOf,
  sessionOfKey,
} from './ledger'

const NOW = 100 * STALE_MS

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
  const l = view({ 'turns:a': [turn('a', 1)], 'turns:bad': 'x', 'ended:a': { at: 2 }, 'pushed:b': { at: 3, lastAt: 2 }, 'pushed:x': { at: 3 }, 'claim:c': { by: 'z', at: 4 }, 'claim:d': 'junk', turns: [] })
  expect([...l.turns.keys()]).toEqual(['a'])
  expect(l.malformed).toEqual(['turns:bad'])
  expect([...l.ended]).toEqual(['a'])
  expect([...l.pushed]).toEqual([['b', { at: 3, lastAt: 2 }]])
  expect([...l.claims.keys()]).toEqual(['c'])
})

test('finished: ended, or no turn for STALE_MS (a crashed session); a fresh session without ended: is live', () => {
  expect(isFinished('a', new Set(['a']), NOW, NOW)).toBe(true)
  expect(isFinished('a', new Set(), NOW - STALE_MS, NOW)).toBe(true)
  expect(isFinished('a', new Set(), NOW - STALE_MS + 1, NOW)).toBe(false)
})

test('I3 handoverPlan: the finished others, oldest first; pending those whose pushed: does not cover them; never the own one or a live one', () => {
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
    'pushed:resumed': { at: NOW - 70, lastAt: NOW - 80 },
  })
  expect(handoverPlan(l, 'own', NOW)).toEqual({ finished: ['stale', 'pushed', 'resumed', 'ended-new'], pending: ['stale', 'resumed', 'ended-new'] })
})

const sized = (session: string, bytes: number, newest: number, ended: boolean, pushed: boolean): Sized => ({ session, bytes, newest, ended, pushed })

test('I4 I2 evictions: the oldest ended go, pushed before unpushed; a session without ended: never; refused when that is not enough', () => {
  const others = [
    sized('live-old', 100, 1, false, false),
    sized('unpushed-old', 100, 2, true, false),
    sized('pushed-new', 100, 9, true, true),
    sized('pushed-old', 100, 3, true, true),
    sized('unpushed-new', 100, 8, true, false),
  ]
  expect(evictions(others, 100, 600)).toEqual([])
  expect(evictions(others, 100, 500)).toEqual(['pushed-old'])
  expect(evictions(others, 100, 300)).toEqual(['pushed-old', 'pushed-new', 'unpushed-old'])
  expect(evictions(others, 100, 200)).toEqual(['pushed-old', 'pushed-new', 'unpushed-old', 'unpushed-new'])
  expect(evictions(others, 101, 200)).toBeNull()
})

test('I4 ownWithin: the own records fit the room, oldest dropped, and keyBytes counts what is kept', () => {
  const records = Array.from({ length: 10 }, (_, i) => turn('own', i))
  const room = keyBytes('turns:own', records.slice(4))
  const kept = ownWithin('own', records, room)
  expect(kept).toEqual(records.slice(4))
  expect(keyBytes('turns:own', kept)).toBeLessThanOrEqual(room)
  expect(ownWithin('own', records, 0)).toEqual([])
})

test('orphans: ended/pushed/claim keys whose session has no turns: key, never the own one', () => {
  const keys = ['turns:a', 'ended:a', 'pushed:a', 'claim:gone', 'pushed:gone', 'ended:own', 'turns', 'claim:a', 'claim:aggregate', 'legacy:l', 'pushed:l']
  expect(orphans(keys, 'own')).toEqual(['claim:gone', 'pushed:gone'])
})

// A store as a plain object; a plan applied to it the way register.tsx migrate() applies it.
const applied = (store: Record<string, unknown>, plan: ReturnType<typeof migrationPlan>): Record<string, unknown> => {
  const next = { ...store }
  for (const [k, v] of plan.sets) next[k] = JSON.parse(JSON.stringify(v))
  for (const k of plan.deletes) delete next[k]
  return next
}
const planOf = (store: Record<string, unknown>) => migrationPlan(store[LEGACY_TURNS], store[LEGACY_PUSHED], new Set(Object.keys(store)), (id) => store[`turns:${id}`] as TurnRecord[] | undefined)

test('I5 migration: legacy turns and pushed move per session; twice equals once; two processes at once equal once', () => {
  const legacy = {
    turns: [turn('a', 1), turn('b', 2), turn('a', 3)],
    pushed: ['a', 'gone', 'a', 'b'],
    'turns:b': [turn('b', 2), turn('b', 4)],
  }
  const once = applied(legacy, planOf(legacy))
  expect(once).toEqual({ 'legacy:a': [turn('a', 1), turn('a', 3)], 'legacy:b': [turn('b', 2)], 'turns:b': [turn('b', 2), turn('b', 4)], 'pushed:a': { at: 0, lastAt: 3 }, 'pushed:b': { at: 0, lastAt: 4 } })
  expect(view(once).turns.get('b')).toEqual([turn('b', 2), turn('b', 4)])
  expect(applied(once, planOf(once))).toEqual(once)
  // Both processes planned from the same store before either wrote: the same values land twice.
  const p = planOf(legacy)
  expect(applied(applied(legacy, p), p)).toEqual(once)
  expect(planOf(once)).toEqual({ sets: [], deletes: [], malformed: false })
})

test('I5 migration: a legacy ledger is trimmed as the old loader kept it; a non-list is dropped and named', () => {
  const many = Array.from({ length: 3005 }, (_, i) => turn('s', i))
  const plan = migrationPlan(many, undefined, new Set([LEGACY_TURNS]), () => undefined)
  expect((plan.sets[0]?.[1] as TurnRecord[]).length).toBe(3000)
  expect((plan.sets[0]?.[1] as TurnRecord[])[0]?.at).toBe(5)
  expect(migrationPlan('garbage', 'garbage', new Set(), () => undefined)).toEqual({ sets: [], deletes: [LEGACY_TURNS, LEGACY_PUSHED], malformed: true })
})

test('coverage: only a numeric lastAt covers, up to that record; the legacy { at: 0 } and junk cover nothing', () => {
  expect(isCovered(undefined, 5)).toBe(false)
  expect(isCovered(pushedOf({ at: 100, lastAt: 5 }), 5)).toBe(true)
  expect(isCovered(pushedOf({ at: 100, lastAt: 5 }), 6)).toBe(false)
  expect(pushedOf({ at: 0 })).toBeUndefined()
  expect(pushedOf({ at: 100 })).toBeUndefined()
  expect(pushedOf('junk')).toBeUndefined()
  expect(pushedOf({ at: 1, lastAt: 2, memoryId: 3 })).toEqual({ at: 1, lastAt: 2 })
})

// F5: the migration writes legacy:<sid> only, a key no owner writes; the ledger is turns: union legacy:.
test('F5 two migrations around one live owner write: the owner record survives', () => {
  const b = (at: number) => turn('B', at)
  const legacy: Record<string, unknown> = { turns: [b(1)] }
  const stale = planOf(legacy) // C plans here, applies after the owner's write
  const once = applied(legacy, stale)
  once['turns:B'] = [...(layoutOf(new Map(Object.entries(once))).turns.get('B') ?? []), b(2)] // B, live, writes its own key
  const after = applied(once, stale)
  expect((layoutOf(new Map(Object.entries(after))).turns.get('B') ?? []).map((r) => r.turnId)).toEqual(['B-1', 'B-2'])
})

test('frictions: is a session key family: deleted with its session, an orphan without a records key, never the own one', () => {
  expect(SESSION_PREFIXES).toContain(FRICTIONS)
  expect(SESSION_PREFIXES).toContain('transcript:')
  expect(SESSION_PREFIXES[0]).toBe('turns:') // records first
  const keys = ['turns:a', 'frictions:a', 'transcript:a', 'transcript:gone', 'frictions:gone', 'frictions:own', 'legacy:l', 'frictions:l']
  expect(orphans(keys, 'own')).toEqual(['transcript:gone', 'frictions:gone'])
})

test('the layout reads the transcript an ended: names and the frictions: rows; an older ended: names none and is no crash', () => {
  const row = { kind: 'hook-block', signature: 's', count: 1 }
  const l = view({
    'ended:a': { at: 1, transcript: '/t/legacy.jsonl' },
    'transcript:a': { path: '/t/a.jsonl' },
    'transcript:t2': { path: '/t/t2.jsonl' },
    'transcript:badpath': { path: 5 },
    'transcript:str': 'x',
    'ended:old2': { at: 1, transcript: '/t/old2.jsonl' },
    'ended:old': { at: 1 },
    'ended:empty': { at: 1, transcript: '' },
    'ended:junk': 'x',
    'ended:num': { at: 1, transcript: 5 },
    'frictions:a': [row, 'damaged'],
    'frictions:none': [],
    'frictions:bad': 'x',
    'frictions:gone': { unavailable: 'missing' },
    'frictions:big': { unavailable: 'too-large' },
  })
  expect([...l.ended].sort()).toEqual(['a', 'empty', 'junk', 'num', 'old', 'old2'])
  // a transcript: key wins over a legacy ended: value; a legacy one stands alone; a damaged key names none
  expect(Object.fromEntries(l.transcripts)).toEqual({ a: '/t/a.jsonl', t2: '/t/t2.jsonl', old2: '/t/old2.jsonl' })
  expect([...l.frictions]).toEqual([['a', [row]], ['none', []], ['gone', []], ['big', []]])
})

test('frictionTargets: ended with a transcript, in the window, not measured, not the own; newest first, at most FRICTION_BATCH', () => {
  const entries: Record<string, unknown> = { 'turns:own': [turn('own', 90)], 'ended:own': { at: 1, transcript: '/t/own' } }
  for (const [s, at] of [['a', 10], ['b', 20], ['c', 30], ['d', 40], ['e', 50]] as const) {
    entries[`turns:${s}`] = [turn(s, at)]
    entries[`ended:${s}`] = { at }
    entries[`transcript:${s}`] = { path: `/t/${s}` }
  }
  entries['frictions:e'] = [] // measured: [] is a result, not a gap
  entries['transcript:live'] = { path: '/t/live' } // classic.SessionEnd ran, session.end not yet: not ended
  entries['turns:old'] = [turn('old', 5)]
  entries['ended:old'] = { at: 5 } // no transcript: not measurable
  entries['turns:live'] = [turn('live', 99)] // not ended
  const l = view(entries)
  const all = new Set(['own', 'a', 'b', 'c', 'd', 'e', 'old', 'live'])
  expect(FRICTION_BATCH).toBe(3)
  expect(frictionTargets(l, all, 'own').map((t) => t.session)).toEqual(['d', 'c', 'b'])
  expect(frictionTargets(l, all, 'own')[0]).toEqual({ session: 'd', transcript: '/t/d' })
  expect(frictionTargets(l, new Set(['a', 'b']), 'own').map((t) => t.session)).toEqual(['b', 'a'])
  expect(frictionTargets(view({}), all, 'own')).toEqual([])
})

test('frictionsBySession: live events stand alone without a transcript; with one the larger count of a row seen by both stands; an unobserved session is absent', () => {
  const live = [{ kind: 'harness-refusal' as const, signature: 'blocked X', count: 2 }]
  const view = layoutOf(
    new Map<string, unknown>([
      ['turns:a', [turn('a', 1, { frictions: live })]],
      ['turns:b', [turn('b', 1, { frictions: live })]],
      ['frictions:b', [{ kind: 'harness-refusal', signature: 'blocked X', count: 5 }, { kind: 'hook-block', signature: 'stop', count: 1 }]],
      ['turns:c', [turn('c', 1)]],
      ['turns:d', [turn('d', 1)]],
      ['frictions:d', [{ kind: 'hook-block', signature: 'stop', count: 3 }]],
    ]),
  )
  const by = frictionsBySession(view)
  expect(by.get('a')).toEqual(live)
  expect(by.get('b')).toEqual([
    { kind: 'harness-refusal', signature: 'blocked X', count: 5 },
    { kind: 'hook-block', signature: 'stop', count: 1 },
  ])
  expect(by.has('c')).toBe(false)
  expect(by.get('d')).toEqual([{ kind: 'hook-block', signature: 'stop', count: 3 }])
})
