import { expect, test } from 'claude-code/testing'

import type { AgentRecord, TurnRecord } from '../types'
import {
  LEDGER_BYTES,
  MAX_AGENTS,
  advisorStats,
  agentStats,
  applied,
  emptyCalibration,
  goalStatus,
  outcomeOf,
  parseCalibration,
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

test('M20 the moves of a calibration file survive reading it: their frozen pre statistics are never discarded', () => {
  const move = { phase: 'test' as const, at: 7, from: 'medium' as const, to: 'high' as const, pre: { byClass: { bugfix: { steps: 160, errors: 48 } }, sessions: { abcdef12: 'achieved' as const } }, post: null }
  const c = { ...emptyCalibration(), phases: { test: 'high' as const }, changes: { test: { at: 7, from: 'medium' as const, to: 'high' as const } }, moves: [move], updatedAt: 7 }
  expect(parseCalibration(JSON.stringify(c)).moves).toEqual([move])
  expect(parseCalibration(JSON.stringify({ ...c, moves: 'not a list' })).moves).toEqual([])
})

test('applying writes the new effort and its evidence; a calibration file of another shape is refused', () => {
  const c = applied(emptyCalibration(), [{ phase: 'test', from: 'medium', to: 'high', evidence: 'e', rate: { errors: 1, steps: 2, lo: 0, hi: 1 }, reference: { errors: 0, steps: 2, lo: 0, hi: 1 } }], 7)
  expect(c).toEqual({
    version: 1,
    phases: { test: 'high' },
    evidence: { test: 'medium → high: e' },
    changes: { test: { at: 7, from: 'medium', to: 'high' } },
    moves: [],
    updatedAt: 7,
  })
  expect(parseCalibration(JSON.stringify(c))).toEqual(c)
  // A file written before `changes` and `moves` existed reads with none.
  expect(parseCalibration('{"version":1,"phases":{"test":"high"}}').changes).toEqual({})
  expect(parseCalibration('{"version":1,"phases":{"test":"high"}}').moves).toEqual([])
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

test('trimmed counts the events a record carries: the byte cap holds with a full event list on every record', () => {
  const events = Array.from({ length: 40 }, (_, i) => ({ at: i, kind: 'commit' as const, src: 'command' as const, sha: `${i}`.padStart(10, 'a'), ok: true }))
  const records = Array.from({ length: 200 }, (_, i) => ({ ...turn({ turnId: `t${i}`, at: i }), events }))
  const cap = 200_000
  const kept = trimmed(records, cap)
  expect(kept.length).toBeLessThan(records.length)
  expect(kept.reduce((n, r) => n + recordBytes(r), 1)).toBeLessThanOrEqual(cap)
  expect(kept[kept.length - 1]).toBe(records[records.length - 1])
})
