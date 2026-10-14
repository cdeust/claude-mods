import { expect, test } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import { pendingSessions, sessionSummary } from './consumer'

// 1_700_000_000_000 ms is 2023-11-14T22:13:20Z.
const AT = 1_700_000_000_000

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

const AGENT = { agentId: 'a1', type: 'Explore', phase: 'analysis' as const, model: 'claude-opus-5-5', steps: 3, errors: 0, design: null }

test('a session summary is a self-contained text: its own header, then the brief lines over that session only', () => {
  const records = [turn('abcdef12-0000', AT - 5000, { agents: [AGENT] }), turn('abcdef12-0000', AT)]
  expect(sessionSummary(records, 'abcdef12-0000')).toBe(
    [
      'Self-calibration of session abcdef12 (2023-11-14), zetetic-insights ledger:',
      '- main thread on opus/fable: 60% of its measured steps only read files (Read, Grep, Glob); those reads need no heavy model.',
      '- delegations: 1 (0 with a DESIGN block); overkill 1, underpowered 0, undesigned 1, rerouted 0.',
      '- latest flagged: Explore on claude-opus-5-5 (effort unset), 3 steps, 0 failed: undesigned, overkill.',
      '- steps by model: opus 100%.',
    ].join('\n'),
  )
})

test('the other sessions records are excluded', () => {
  const other = turn('zzzzzzzz-1111', AT + 1000, { mainModel: 'claude-haiku-5-5', agents: [AGENT, { ...AGENT, agentId: 'a2' }] })
  const mine = turn('abcdef12-0000', AT)
  const alone = sessionSummary([mine], 'abcdef12-0000')
  expect(sessionSummary([other, mine], 'abcdef12-0000')).toBe(alone)
  expect(alone).not.toMatch(/haiku|delegations/)
  expect(alone).toMatch(/\(2023-11-14\)/)
})

test('a session with no main step has no summary', () => {
  const idle = turn('idle0000-1', AT, { main: [] })
  const zero = turn('zero0000-1', AT, { main: [{ phase: 'analysis', effort: 'medium', steps: 0, errors: 0 }] })
  expect(sessionSummary([idle, zero], 'idle0000-1')).toBeNull()
  expect(sessionSummary([idle, zero], 'zero0000-1')).toBeNull()
  expect(sessionSummary([idle], 'absent')).toBeNull()
})

test('every line is cut to 200 characters', () => {
  const long = { ...AGENT, type: 'x'.repeat(400) }
  const text = sessionSummary([turn('abcdef12-0000', AT, { agents: [long] })], 'abcdef12-0000') ?? ''
  expect(text.split('\n').every((l) => l.length <= 200)).toBe(true)
})

test('pendingSessions: oldest first, never the current one or one already handed over, none without a summary', () => {
  const records = [turn('b', 200), turn('a', 100), turn('cur', 300), turn('done', 50), turn('idle', 60, { main: [] }), turn('a', 150)]
  expect(pendingSessions(records, 'cur', new Set(['done']))).toEqual(['a', 'b'])
})
