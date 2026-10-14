import { expect, test } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import {
  MIN_STEPS,
  advisorStats,
  agentStats,
  applied,
  emptyCalibration,
  goalStatus,
  outcomeOf,
  parseCalibration,
  phaseStats,
  proposals,
} from './learn'

const turn = (over: Partial<TurnRecord>): TurnRecord => ({
  session: 's1',
  turnId: 't',
  at: 0,
  taskClass: null,
  main: [],
  agents: [],
  advisor: { calls: 0, beforeWrite: 0, atCompletion: 0 },
  stuck: 0,
  ...over,
})

test('a facet outcome is achieved, not achieved, or unclear; a broken facet says so', () => {
  expect(outcomeOf('{"outcome":"fully_achieved"}')).toBe('achieved')
  expect(outcomeOf('{"outcome":"mostly_achieved"}')).toBe('achieved')
  expect(outcomeOf('{"outcome":"partially_achieved"}')).toBe('not-achieved')
  expect(outcomeOf('{"outcome":"unclear_from_transcript"}')).toBe('unclear')
  expect(() => outcomeOf('{oops')).toThrow(/facet is not valid JSON/)
})

test("a goal's state is its last status line", () => {
  expect(goalStatus('# G\nstatus: active\n### Iteration 1\nstatus: met\n')).toBe('met')
  expect(goalStatus('# G\nno status\n')).toBe('none')
})

test('main runs add up per phase and effort, with the sessions /insights judged', () => {
  const records = [
    turn({ session: 's1', main: [{ phase: 'analysis', effort: 'medium', steps: 3, errors: 1 }, { phase: 'test', effort: 'low', steps: 2, errors: 0 }] }),
    turn({ session: 's2', main: [{ phase: 'analysis', effort: 'medium', steps: 5, errors: 0 }] }),
  ]
  const outcomes = new Map([['s1', 'achieved' as const], ['s2', 'unclear' as const]])
  expect(phaseStats(records, outcomes)).toEqual([
    { phase: 'analysis', effort: 'medium', steps: 8, errors: 1, sessions: 2, judged: 1, achieved: 1 },
    { phase: 'test', effort: 'low', steps: 2, errors: 0, sessions: 1, judged: 1, achieved: 1 },
  ])
})

test('a phase failing often enough at its effort is proposed one notch up', () => {
  const stats = [{ phase: 'test', effort: 'medium', steps: MIN_STEPS, errors: 12, sessions: 4, judged: 0, achieved: 0 }]
  expect(proposals(stats, emptyCalibration())).toEqual([
    { phase: 'test', from: 'medium', to: 'high', evidence: '12 failed calls in 40 steps at medium over 4 sessions' },
  ])
  expect(proposals([{ ...stats[0]!, steps: MIN_STEPS - 1 }], emptyCalibration())).toEqual([])
})

test('a phase is lowered only when it almost never fails and /insights says the sessions were achieved', () => {
  const quiet = { phase: 'analysis', effort: 'medium', steps: 100, errors: 2, sessions: 9, judged: 6, achieved: 5 }
  expect(proposals([quiet], emptyCalibration())[0]?.to).toBe('low')
  expect(proposals([{ ...quiet, achieved: 4 }], emptyCalibration())).toEqual([])
  expect(proposals([{ ...quiet, judged: 4, achieved: 4 }], emptyCalibration())).toEqual([])
})

test('proposals start from the calibrated effort and never leave low..high', () => {
  const c = { ...emptyCalibration(), phases: { analysis: 'low' as const } }
  expect(proposals([{ phase: 'analysis', effort: 'low', steps: 100, errors: 0, sessions: 9, judged: 9, achieved: 9 }], c)).toEqual([])
  const high = { ...emptyCalibration(), phases: { review: 'high' as const } }
  expect(proposals([{ phase: 'review', effort: 'high', steps: 100, errors: 60, sessions: 9, judged: 0, achieved: 0 }], high)).toEqual([])
})

test('applying writes the new effort and its evidence; a calibration file of another shape is refused', () => {
  const c = applied(emptyCalibration(), [{ phase: 'test', from: 'medium', to: 'high', evidence: 'e' }], 7)
  expect(c).toEqual({ version: 1, phases: { test: 'high' }, evidence: { test: 'medium → high: e' }, updatedAt: 7 })
  expect(parseCalibration(JSON.stringify(c))).toEqual(c)
  expect(() => parseCalibration('{"phases":{}}')).toThrow(/version 1/)
})

test('agents and the advisor are summed per type and per grade', () => {
  const records = [
    turn({ taskClass: 'analysis', advisor: { calls: 2, beforeWrite: 1, atCompletion: 1 }, agents: [{ type: 'Explore', phase: 'analysis', model: 'claude-haiku-5-5', steps: 4, errors: 1 }] }),
    turn({ taskClass: 'routine', advisor: { calls: 1, beforeWrite: 1, atCompletion: 0 }, agents: [{ type: 'Explore', phase: 'analysis', model: 'claude-sonnet-5-5', steps: 2, errors: 0 }] }),
  ]
  expect(agentStats(records)).toEqual([{ type: 'Explore', runs: 2, steps: 6, errors: 1, models: ['claude-haiku-5-5', 'claude-sonnet-5-5'] }])
  expect(advisorStats(records)).toEqual({ heavyTurns: 1, heavyBeforeWrite: 1, heavyAtCompletion: 1, lightTurns: 1, lightWithAdvisor: 1 })
})
