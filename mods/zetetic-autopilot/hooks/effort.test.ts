import { expect, test } from 'claude-code/testing'

import { EFFORTS_CAP, type SpawnFacts, callEnded, callOf, callStarted, decidedFor, holdEffort, keep, resetEfforts, stepEffort, subagentEffort } from './effort'

// The rule of effort.ts, one fact at a time (ADR-9850), and the bounds of what it keeps.

const INHERITING: SpawnFacts = { fixed: false, call: {}, definition: {}, grade: 'low' }

test('an inheriting type with no call or definition effort takes the grade\'s effort', () => {
  expect(subagentEffort(INHERITING)).toEqual({ effort: 'low', reason: 'grade' })
  expect(subagentEffort({ ...INHERITING, definition: { model: 'inherit' } })).toEqual({ effort: 'low', reason: 'grade' })
})

test('every fact that makes the effort another\'s decides nothing, whatever the grade', () => {
  const cases: [Partial<SpawnFacts>, string][] = [
    [{ fixed: true }, 'fixed'],
    [{ call: undefined }, 'unseen'],
    [{ call: { effort: 'medium' } }, 'call'],
    [{ definition: undefined }, 'unread'],
    [{ definition: { effort: 'high' } }, 'definition'],
    [{ definition: { model: 'inherit', effort: 'high' } }, 'definition'],
    [{ definition: { model: 'opus' } }, 'pinned'],
    [{ grade: undefined }, 'ungraded'],
  ]
  for (const [facts, reason] of cases) expect(subagentEffort({ ...INHERITING, ...facts })).toEqual({ effort: undefined, reason })
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
  expect(callOf('u1')).toEqual({ effort: 'high' })
  expect(callOf('u2')).toEqual({})
  expect(callOf('u3')).toEqual({})
  callEnded('u1')
  expect(callOf('u1')).toBeUndefined()
  expect(callOf('never')).toBeUndefined()
  resetEfforts()
  expect(callOf('u2')).toBeUndefined()
})

test('a step is rewritten only to a decided effort it does not carry, and only when it carries a level', () => {
  expect(stepEffort('low', 'high')).toBe('low')
  expect(stepEffort('low', 'low')).toBeUndefined()
  expect(stepEffort(undefined, 'high')).toBeUndefined()
  expect(stepEffort('low', undefined)).toBeUndefined()
  expect(stepEffort('low', 2048)).toBeUndefined()
})
