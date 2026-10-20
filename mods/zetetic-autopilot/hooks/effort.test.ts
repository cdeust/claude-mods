import { expect, test } from 'claude-code/testing'

import { EFFORTS_CAP, type SpawnFacts, callEnded, callOf, callStarted, decidedFor, holdEffort, keep, resetEfforts, stepEffort, subagentEffort } from './effort'

// The rule of effort.ts, one fact at a time (ADR-9850), and the bounds of what it keeps.

const INHERITING: SpawnFacts = { fixed: false, call: {}, definition: {}, steer: { by: 'none' }, grade: 'low' }

test('an inheriting type with no call or definition effort takes the grade\'s effort', () => {
  expect(subagentEffort(INHERITING)).toEqual({ effort: 'low', reason: 'grade' })
  expect(subagentEffort({ ...INHERITING, definition: { model: 'inherit' } })).toEqual({ effort: 'low', reason: 'grade' })
})

test('every fact that makes the effort another\'s decides nothing, whatever the grade', () => {
  const cases: [Partial<SpawnFacts>, string][] = [
    [{ fixed: true }, 'fixed'],
    [{ call: undefined }, 'unseen'],
    [{ call: { effort: 'medium' } }, 'call'],
    [{ call: { effort: 'higher' } }, 'call'],
    [{ definition: undefined }, 'unread'],
    [{ definition: { effort: 'high' } }, 'definition'],
    [{ definition: { model: 'inherit', effort: 'high' } }, 'definition'],
    [{ definition: { model: 'opus' } }, 'pinned'],
    [{ grade: undefined }, 'ungraded'],
  ]
  for (const [facts, reason] of cases) expect(subagentEffort({ ...INHERITING, ...facts })).toEqual({ effort: undefined, reason })
})

// ADR-9851: DESIGN and the table decide after every explicit fact and before the grade; a failed classifier decides
// nothing and does not fall back to the grade.
test('DESIGN and the table decide before the grade, after every explicit fact; a failed class leaves the engine\'s', () => {
  const design = { by: 'design', effort: 'high' } as const
  const table = { by: 'table', model: 'opus', effort: 'medium', cls: 'analysis', review: false, rung: 'opus/medium' } as const
  expect(subagentEffort({ ...INHERITING, steer: design })).toEqual({ effort: 'high', reason: 'design' })
  expect(subagentEffort({ ...INHERITING, steer: table })).toEqual({ effort: 'medium', reason: 'table' })
  expect(subagentEffort({ ...INHERITING, steer: { by: 'design', model: 'opus' } })).toEqual({ effort: 'low', reason: 'grade' })
  expect(subagentEffort({ ...INHERITING, steer: { by: 'unclassified', why: 'x' } })).toEqual({ effort: undefined, reason: 'unclassified' })
  for (const steer of [design, table]) {
    expect(subagentEffort({ ...INHERITING, steer, call: { effort: 'low' } }).reason).toBe('call')
    expect(subagentEffort({ ...INHERITING, steer, definition: { effort: 'low' } }).reason).toBe('definition')
    expect(subagentEffort({ ...INHERITING, steer, definition: { model: 'sonnet' } }).reason).toBe('pinned')
    expect(subagentEffort({ ...INHERITING, steer, fixed: true }).reason).toBe('fixed')
    expect(subagentEffort({ ...INHERITING, steer, call: undefined }).reason).toBe('unseen')
  }
})

test('the order: a call effort beats an unread definition, a fork beats an unseen call', () => {
  expect(subagentEffort({ ...INHERITING, call: { effort: 'high' }, definition: undefined }).reason).toBe('call')
  expect(subagentEffort({ ...INHERITING, fixed: true, call: undefined }).reason).toBe('fixed')
})

test('keep: the bound holds, the oldest goes first, and a key set again is the newest', () => {
  const m = new Map<string, number>()
  for (let i = 0; i < 4; i++) keep(m, `k${i}`, i, 3)
  expect([...m.keys()]).toEqual(['k1', 'k2', 'k3'])
  keep(m, 'k1', 9, 3)
  keep(m, 'k4', 4, 3)
  expect([...m.entries()]).toEqual([['k3', 3], ['k1', 9], ['k4', 4]])
})

test('the decided efforts are bounded by EFFORTS_CAP: one past it forgets the oldest agent', () => {
  resetEfforts()
  for (let i = 0; i <= EFFORTS_CAP; i++) holdEffort(`ag-${i}`, 'low')
  expect(decidedFor('ag-0')).toBeUndefined()
  expect(decidedFor('ag-1')).toBe('low')
  expect(decidedFor(`ag-${EFFORTS_CAP}`)).toBe('low')
  resetEfforts()
  expect(decidedFor('ag-1')).toBeUndefined()
})

test('an Agent call is known while its tool runs, with its effort or none, and gone after', () => {
  resetEfforts()
  callStarted('u1', 'high')
  callStarted('u2', undefined)
  callStarted('u3', 7)
  callStarted('u4', 'lower')
  expect(callOf('u1')).toEqual({ effort: 'high' })
  expect(callOf('u2')).toEqual({})
  // Any effort the call names is kept as it came: it stands, whether or not it is one of the five levels.
  expect(callOf('u3')).toEqual({ effort: 7 })
  expect(callOf('u4')).toEqual({ effort: 'lower' })
  callEnded('u1')
  expect(callOf('u1')).toBeUndefined()
  expect(callOf('never')).toBeUndefined()
  resetEfforts()
  expect(callOf('u2')).toBeUndefined()
})

test('a step goes out at a decided effort only when it carries an effort level', () => {
  expect(stepEffort('low', 'high')).toBe('low')
  expect(stepEffort('low', 'low')).toBe('low')
  expect(stepEffort(undefined, 'high')).toBeUndefined()
  expect(stepEffort('low', undefined)).toBeUndefined()
  expect(stepEffort('low', 2048)).toBeUndefined()
})
