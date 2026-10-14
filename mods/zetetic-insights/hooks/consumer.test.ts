import { expect, test } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import { aggregateSummary, rememberOutcome } from './consumer'

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

test('the aggregate is a self-contained text: its own header over the finished sessions, then the brief lines', () => {
  const records = [turn('abcdef12-0000', AT - 5000, { agents: [AGENT] }), turn('zzzzzzzz-1111', AT)]
  expect(aggregateSummary(records, AT)).toBe(
    [
      'Self-calibration (zetetic-insights, last 2 finished sessions, as of 2023-11-14):',
      '- main thread on opus/fable: 60% of its measured steps only read files (Read, Grep, Glob); those reads need no heavy model.',
      '- delegations: 1 (0 with a DESIGN block); overkill 1, underpowered 0, undesigned 1, rerouted 0.',
      '- latest flagged: Explore on claude-opus-5-5 (effort unset), 3 steps, 0 failed: undesigned, overkill.',
      '- steps by model: opus 100%.',
    ].join('\n'),
  )
})

test('nothing measured has no aggregate; every line is cut to 200 characters', () => {
  expect(aggregateSummary([], AT)).toBeNull()
  const long = { ...AGENT, type: 'x'.repeat(400) }
  const text = aggregateSummary([turn('abcdef12-0000', AT, { agents: [long] })], AT) ?? ''
  expect(text.split('\n').every((l) => l.length <= 200)).toBe(true)
})

// The reply shapes are Cortex's own: remember_response.py 69-123, remember_helpers.py 821-873,
// core/write_gate.py 145-166.
const sc = (structuredContent: Record<string, unknown>) => rememberOutcome({ content: [], isError: false, structuredContent })
test('rememberOutcome: stored or superseded is the new head; merged is another memory; unparsed and isError fail', () => {
  expect(sc({ stored: true, memory_id: 42, action: 'stored', reason: 'novel' })).toEqual({ kind: 'head', memoryId: 42 })
  expect(rememberOutcome({ content: [{ type: 'text', text: '{"stored":true,"memory_id":43,"action":"superseded"}' }], isError: false })).toEqual({ kind: 'head', memoryId: 43 })
  expect(sc({ stored: true, memory_id: 7, action: 'merged', reason: 'merged_with_existing' })).toEqual({ kind: 'merged', memoryId: 7 })
  expect(rememberOutcome({ content: [{ type: 'text', text: 'stored' }], isError: false }).kind).toBe('failed')
  expect(rememberOutcome({ content: [{ type: 'text', text: 'down' }], isError: true })).toEqual({ kind: 'failed', failure: 'down' })
})

test('rememberOutcome: a gate rejection is redundant; a missing head clears it; a moved head is followed', () => {
  expect(sc({ stored: false, action: 'rejected', reason: 'low_novelty', importance: 0.2 })).toEqual({ kind: 'redundant', reason: 'low_novelty' })
  expect(sc({ stored: false, action: 'rejected', reason: 'supersede_target_not_found', supersede_target_id: 5 })).toEqual({ kind: 'moved', memoryId: null, reason: 'supersede_target_not_found' })
  expect(sc({ stored: false, action: 'rejected', reason: 'supersede_target_already_superseded', supersede_target_id: 5, current_superseded_by_id: 9 })).toEqual({ kind: 'moved', memoryId: 9, reason: 'supersede_target_already_superseded' })
  expect(sc({ stored: false, action: 'superseded_conflict', reason: 'supersede_chain_head_moving', supersede_target_id: 5, current_head_id: 11 })).toEqual({ kind: 'moved', memoryId: 11, reason: 'supersede_chain_head_moving' })
})
