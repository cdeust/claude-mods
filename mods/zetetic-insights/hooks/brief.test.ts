import { expect, test } from 'claude-code/testing'

import type { AgentRecord, DelegationStats, MechanicalShare, RunRecord, TurnRecord } from '../types'
import { BRIEF_LINE_CAP, BRIEF_MAX_LINES, briefOf, composeBrief, mechanicalShare } from './brief'
import { emptyDelegations } from './delegations'
import { sessionModels } from './models'

const run = (phase: RunRecord['phase'], steps: number): RunRecord => ({ phase, effort: 'medium', steps, errors: 0 })
const agent = (model: string, steps: number): AgentRecord => ({ type: 'Explore', phase: 'analysis', model, steps, errors: 0 })
const turn = (session: string, at: number, mainModel: string | undefined, main: RunRecord[], agents: AgentRecord[] = []): TurnRecord => ({
  session,
  turnId: `${session}-${at}`,
  at,
  taskClass: null,
  ...(mainModel === undefined ? {} : { mainModel }),
  main,
  agents,
  advisor: { calls: 0, beforeWrite: 0, atCompletion: 0 },
  stuck: 0,
})

// s1: opus 6 analysis + 4 implementation, a haiku agent of 2. s2: haiku main 5 analysis (not heavy),
// then opus 2 analysis + 8 test, and a sonnet agent of 10.
const LEDGER = [
  turn('s1', 10, 'claude-opus-5-5', [run('analysis', 6), run('implementation', 4)], [agent('claude-haiku-5-5', 2)]),
  turn('s2', 20, 'claude-haiku-5-5', [run('analysis', 5)]),
  turn('s2', 21, 'claude-opus-5-5', [run('analysis', 2), run('test', 8)], [agent('claude-sonnet-5-5', 10)]),
]

test('the mechanical share counts analysis steps on opus or fable over all of their main steps, exactly', () => {
  // Heavy: 6 + 4 + 2 + 8 = 20 steps, of which analysis 6 + 2 = 8; the haiku turn's 5 are not heavy.
  expect(mechanicalShare(LEDGER)).toEqual({ sessions: 2, heavyAnalysis: 8, heavySteps: 20, share: 0.4 })
})

test('fable counts as heavy, a record with no mainModel does not, and only the newest sessions are measured', () => {
  const old = turn('s0', 1, 'claude-opus-5-5', [run('analysis', 100)])
  const fable = turn('s3', 30, 'claude-fable-5-5', [run('analysis', 1), run('design', 1)])
  const unknown = turn('s3', 31, undefined, [run('analysis', 50)])
  const out = mechanicalShare([old, ...LEDGER, fable, unknown], 2)
  expect(out).toEqual({ sessions: 2, heavyAnalysis: 3, heavySteps: 12, share: 0.25 })
  expect(mechanicalShare([old, ...LEDGER], 3).heavyAnalysis).toBe(108)
})

test('no heavy step: the share is null, not zero', () => {
  expect(mechanicalShare([turn('s', 1, 'claude-haiku-5-5', [run('analysis', 9)])])).toEqual({ sessions: 1, heavyAnalysis: 0, heavySteps: 0, share: null })
  expect(mechanicalShare([])).toEqual({ sessions: 0, heavyAnalysis: 0, heavySteps: 0, share: null })
})

const NONE: MechanicalShare = { sessions: 0, heavyAnalysis: 0, heavySteps: 0, share: null }
const DELEGATIONS: DelegationStats = {
  total: 7,
  designed: 5,
  flags: { overkill: 3, underpowered: 1, undesigned: 2, rerouted: 1 },
  recent: [
    { at: 1, type: 'Explore', model: 'claude-haiku-5-5', effort: null, shape: null, steps: 6, errors: 3, flags: ['underpowered'] },
    { at: 2, type: 'code-reviewer', model: 'claude-opus-5-5', effort: 'high', shape: null, steps: 3, errors: 0, flags: ['overkill', 'rerouted'] },
  ],
}

test('an empty ledger composes nothing', () => {
  expect(composeBrief({ delegations: emptyDelegations(), models: [], mechanical: NONE })).toBeNull()
  expect(composeBrief({ delegations: emptyDelegations(), models: sessionModels([]), mechanical: mechanicalShare([]) })).toBeNull()
})

test('the full text on a fixture, exactly', () => {
  const text = composeBrief({ delegations: DELEGATIONS, models: sessionModels(LEDGER), mechanical: mechanicalShare(LEDGER) })
  // Steps: haiku 2 + 5 = 7, sonnet 10, opus 6 + 4 + 2 + 8 = 20; 37 in all.
  expect(text).toBe(
    [
      'Self-calibration (zetetic-insights ledger, last 2 sessions). Measured, not prescribed:',
      '- main thread on opus/fable: 40% of its steps were reading (analysis); a haiku or sonnet delegation could have done them.',
      '- delegations: 7 (5 with a DESIGN block); overkill 3, underpowered 1, undesigned 2, rerouted 1.',
      '- latest flagged: code-reviewer on claude-opus-5-5 (high), 3 steps, 0 failed: overkill, rerouted.',
      '- steps by model: haiku 19%, sonnet 27%, opus 54%.',
    ].join('\n'),
  )
})

test('only what is measured is said: no share, no delegation, an unset effort', () => {
  const text = composeBrief({ delegations: { ...DELEGATIONS, recent: [DELEGATIONS.recent[0]!] }, models: [], mechanical: NONE })
  expect(text?.split('\n')).toEqual([
    'Self-calibration (zetetic-insights ledger, last 0 sessions). Measured, not prescribed:',
    '- delegations: 7 (5 with a DESIGN block); overkill 3, underpowered 1, undesigned 2, rerouted 1.',
    '- latest flagged: Explore on claude-haiku-5-5 (effort unset), 6 steps, 3 failed: underpowered.',
  ])
})

test('a share alone is enough to compose', () => {
  const text = composeBrief({ delegations: emptyDelegations(), models: [], mechanical: { sessions: 1, heavyAnalysis: 1, heavySteps: 3, share: 1 / 3 } })
  expect(text?.split('\n')[1]).toBe('- main thread on opus/fable: 33% of its steps were reading (analysis); a haiku or sonnet delegation could have done them.')
})

test('at most BRIEF_MAX_LINES lines, the richest case included', () => {
  const text = composeBrief({ delegations: DELEGATIONS, models: sessionModels(LEDGER), mechanical: mechanicalShare(LEDGER) }) ?? ''
  expect(BRIEF_MAX_LINES).toBe(6)
  expect(text.split('\n').length).toBeLessThanOrEqual(BRIEF_MAX_LINES)
})

test('a line is cut to BRIEF_LINE_CAP characters', () => {
  const long = { ...DELEGATIONS.recent[1]!, type: 'x'.repeat(500) }
  const text = composeBrief({ delegations: { ...DELEGATIONS, recent: [long] }, models: sessionModels(LEDGER), mechanical: mechanicalShare(LEDGER) }) ?? ''
  const lines = text.split('\n')
  expect(Math.max(...lines.map((l) => l.length))).toBe(BRIEF_LINE_CAP)
  expect(lines[3]?.length).toBe(200)
  expect(lines[3]?.startsWith('- latest flagged: xxx')).toBe(true)
})

test('one window: the brief counts the newest 10 sessions only, the 11th (oldest) is in none of its lines', () => {
  const oldest = {
    ...turn('s00', 1, 'claude-opus-5-5', [run('analysis', 500)], [{ ...agent('claude-opus-5-5', 2), agentId: 'x', design: null }]),
  }
  const rest = Array.from({ length: 10 }, (_, i) => turn(`s${i + 1}`, 10 + i, 'claude-haiku-5-5', [run('implementation', 4)]))
  const text = briefOf([oldest, ...rest]) ?? ''
  expect(text.split('\n')).toEqual([
    'Self-calibration (zetetic-insights ledger, last 10 sessions). Measured, not prescribed:',
    '- steps by model: haiku 100%.',
  ])
  // With the oldest inside the window it does count: opus steps and the overkill delegation appear.
  const all = briefOf([oldest, ...rest.slice(1)]) ?? ''
  expect(all).toMatch(/last 10 sessions/)
  expect(all).toMatch(/reading \(analysis\)/)
  expect(all).toMatch(/overkill 1/)
})
