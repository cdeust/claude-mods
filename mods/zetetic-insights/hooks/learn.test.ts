import { expect, test } from 'claude-code/testing'

import type { AgentRecord, TurnRecord } from '../types'
import {
  LEDGER_BYTES,
  MAX_AGENTS,
  MIN_STEPS,
  REVERSAL_STEPS,
  advisorStats,
  agentStats,
  applied,
  emptyCalibration,
  goalStatus,
  offRung,
  outcomeOf,
  parseCalibration,
  phaseStats,
  proposals,
  recordBytes,
  trimmed,
  utf8Bytes,
  withAgent,
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
  expect(c).toEqual({
    version: 1,
    phases: { test: 'high' },
    evidence: { test: 'medium → high: e' },
    changes: { test: { at: 7, from: 'medium', to: 'high' } },
    updatedAt: 7,
  })
  expect(parseCalibration(JSON.stringify(c))).toEqual(c)
  // A file written before `changes` existed reads with none.
  expect(parseCalibration('{"version":1,"phases":{"test":"high"}}').changes).toEqual({})
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

const agent = (i: number) => ({ type: `agent-${i}-${'x'.repeat(150)}`, phase: 'analysis' as const, model: 'claude-haiku-5-5', steps: i, errors: 0 })

test('the ledger keeps the newest records under the byte cap, measured as UTF-8', () => {
  expect(utf8Bytes('aé€😀')).toBe(1 + 2 + 3 + 4)
  expect(utf8Bytes(JSON.stringify(['é']))).toBe(6)
  // 400 agent-heavy records of ~10 KB each: ~4 MB, past the store's 4 MiB.
  const heavy = Array.from({ length: 400 }, (_, i) => turn({ turnId: `t${i}`, agents: Array.from({ length: MAX_AGENTS }, (_, j) => agent(j)) }))
  expect(utf8Bytes(JSON.stringify(heavy))).toBeGreaterThan(4 * 1024 * 1024)
  const kept = trimmed(heavy)
  // Measured as the store file writes it, indented, which is larger than the compact text.
  expect(utf8Bytes(JSON.stringify({ turns: kept }, null, 2))).toBeLessThanOrEqual(LEDGER_BYTES)
  expect(kept[kept.length - 1]?.turnId).toBe('t399')
  expect(kept.length).toBeGreaterThan(100)
  // The count cap still holds, and a ledger under both caps is kept whole.
  expect(trimmed(heavy, Number.POSITIVE_INFINITY, 3).map((r) => r.turnId)).toEqual(['t397', 't398', 't399'])
  expect(trimmed(heavy.slice(0, 2))).toEqual(heavy.slice(0, 2))
  expect(trimmed([])).toEqual([])
})

test('a turn keeps MAX_AGENTS agents and counts the rest', () => {
  let list = { agents: [] as AgentRecord[], dropped: 0 }
  for (let i = 0; i < MAX_AGENTS + 3; i++) list = withAgent(list, agent(i))
  expect(list.agents.length).toBe(MAX_AGENTS)
  expect(list.dropped).toBe(3)
})

test("a moved phase counts only the runs after its move, and undoing the move needs more evidence", () => {
  const runs = (at: number, effort: string, steps: number, errors: number) => turn({ at, main: [{ phase: 'test', effort, steps, errors }] })
  const records = [runs(1, 'medium', 100, 50), runs(20, 'high', 40, 0)]
  const moved = { ...emptyCalibration(), phases: { test: 'high' as const }, changes: { test: { at: 10, from: 'medium' as const, to: 'high' as const } } }
  expect(phaseStats(records, new Map(), moved.changes).map((s) => [s.effort, s.steps])).toEqual([['high', 40]])
  // Clean and achieved at high: lowering back to medium undoes the raise, 40 steps are not enough.
  const clean = { phase: 'test', effort: 'high', steps: MIN_STEPS, errors: 0, sessions: 9, judged: 9, achieved: 9 }
  expect(proposals([clean], moved)).toEqual([])
  expect(proposals([{ ...clean, steps: REVERSAL_STEPS }], moved)[0]?.to).toBe('medium')
  // Failing at high: there is no rung above, and the move is not undone either.
  expect(proposals([{ ...clean, errors: 30 }], moved)).toEqual([])
})

test('a phase with steps only at other rungs is named as unable to produce a proposal', () => {
  const stats = [{ phase: 'test', effort: 'high', steps: 60, errors: 0, sessions: 2, judged: 0, achieved: 0 }]
  expect(offRung(stats, emptyCalibration())).toEqual([{ phase: 'test', now: 'medium', ran: ['high 60'] }])
  expect(offRung([{ ...stats[0]!, effort: 'medium' }], emptyCalibration())).toEqual([])
})

test('trimmed counts the events a record carries: the byte cap holds with a full event list on every record', () => {
  const events = Array.from({ length: 40 }, (_, i) => ({ at: i, kind: 'commit' as const, src: 'command' as const, sha: `${i}`.padStart(10, 'a'), ok: true }))
  const records = Array.from({ length: 200 }, (_, i) => ({ ...turn({ turnId: `t${i}`, at: i }), events }))
  const cap = 200_000
  const kept = trimmed(records, cap)
  expect(kept.length).toBeLessThan(records.length)
  expect(kept.reduce((n, r) => n + recordBytes(r), 1)).toBeLessThanOrEqual(cap)
  expect(kept[kept.length - 1]).toBe(records[records.length - 1])
})
