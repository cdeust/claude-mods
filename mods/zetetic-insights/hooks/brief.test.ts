import { expect, test } from 'claude-code/testing'

import type { AgentRecord, DelegationStats, MechanicalShare, RunRecord, TurnRecord } from '../types'
import { BRIEF_LINE_CAP, BRIEF_MAX_LINES, briefOf, composeBrief, mechanicalShare } from './brief'
import { emptyDelegations } from './delegations'
import { sessionModels } from './models'

const run = (phase: RunRecord['phase'], steps: number, reads = 0): RunRecord => ({ phase, effort: 'medium', steps, errors: 0, reads })
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

// s1: opus 6 analysis (4 only read files, 2 delegated) + 4 implementation, a haiku agent of 2. s2: haiku
// main 5 analysis (not heavy), then opus 2 analysis (1 read) + 8 test, and a sonnet agent of 10.
const LEDGER = [
  turn('s1', 10, 'claude-opus-5-5', [run('analysis', 6, 4), run('implementation', 4)], [agent('claude-haiku-5-5', 2)]),
  turn('s2', 20, 'claude-haiku-5-5', [run('analysis', 5, 5)]),
  turn('s2', 21, 'claude-opus-5-5', [run('analysis', 2, 1), run('test', 8)], [agent('claude-sonnet-5-5', 10)]),
]

test('the mechanical share counts file-read steps on opus or fable over all of their measured main steps, exactly', () => {
  // Heavy: 6 + 4 + 2 + 8 = 20 steps, of which file reads 4 + 0 + 1 + 0 = 5 (the other analysis steps
  // delegated or recalled); the haiku turn's 5 are not heavy.
  expect(mechanicalShare(LEDGER)).toEqual({ sessions: 2, heavyReads: 5, heavySteps: 20, unmeasured: 0, share: 0.25 })
})

test('an older record without reads is unmeasured: not in the share, not counted as zero reads', () => {
  const bare = (phase: RunRecord['phase'], steps: number): RunRecord => ({ phase, effort: 'medium', steps, errors: 0 })
  const older = turn('s2', 22, 'claude-opus-5-5', [bare('analysis', 10), bare('test', 5)])
  expect(mechanicalShare([...LEDGER, older])).toEqual({ sessions: 2, heavyReads: 5, heavySteps: 20, unmeasured: 15, share: 0.25 })
  expect(mechanicalShare([older])).toEqual({ sessions: 1, heavyReads: 0, heavySteps: 0, unmeasured: 15, share: null })
})

test('fable counts as heavy, a record with no mainModel does not, and only the newest sessions are measured', () => {
  const old = turn('s0', 1, 'claude-opus-5-5', [run('analysis', 100, 100)])
  const fable = turn('s3', 30, 'claude-fable-5-5', [run('analysis', 1, 1), run('design', 1)])
  const unknown = turn('s3', 31, undefined, [run('analysis', 50)])
  const out = mechanicalShare([old, ...LEDGER, fable, unknown], 2)
  expect(out).toEqual({ sessions: 2, heavyReads: 2, heavySteps: 12, unmeasured: 0, share: 1 / 6 })
  expect(mechanicalShare([old, ...LEDGER], 3).heavyReads).toBe(5 + 100)
})

test('no heavy step: the share is null, not zero', () => {
  expect(mechanicalShare([turn('s', 1, 'claude-haiku-5-5', [run('analysis', 9)])])).toEqual({ sessions: 1, heavyReads: 0, heavySteps: 0, unmeasured: 0, share: null })
  expect(mechanicalShare([])).toEqual({ sessions: 0, heavyReads: 0, heavySteps: 0, unmeasured: 0, share: null })
})

const NONE: MechanicalShare = { sessions: 0, heavyReads: 0, heavySteps: 0, unmeasured: 0, share: null }
const DELEGATIONS: DelegationStats = {
  total: 7,
  designed: 5,
  outcomes: { achieved: 0, 'not-achieved': 0, unclear: 0 },
  rounds: 0,
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
      '- main thread on opus/fable: 25% of its measured steps only read files (Read, Grep, Glob); those reads need no heavy model.',
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
  const text = composeBrief({ delegations: emptyDelegations(), models: [], mechanical: { sessions: 1, heavyReads: 1, heavySteps: 3, unmeasured: 0, share: 1 / 3 } })
  expect(text?.split('\n')[1]).toBe('- main thread on opus/fable: 33% of its measured steps only read files (Read, Grep, Glob); those reads need no heavy model.')
  const older = composeBrief({ delegations: emptyDelegations(), models: [], mechanical: { sessions: 1, heavyReads: 1, heavySteps: 3, unmeasured: 12, share: 1 / 3 } })
  expect(older?.split('\n')[1]).toBe('- main thread on opus/fable: 33% of its measured steps only read files (Read, Grep, Glob); those reads need no heavy model. (12 older steps unmeasured)')
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
    ...turn('s00', 1, 'claude-opus-5-5', [run('analysis', 500, 500)], [{ ...agent('claude-opus-5-5', 2), agentId: 'x', design: null }]),
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
  expect(all).toMatch(/100% of its measured steps only read files/)
  expect(all).toMatch(/overkill 1/)
})

const FRICTION = { kind: 'hook-block' as const, signature: 'Owned cleanup remains: [{<Q>: <Q>}]', sessions: 3, count: 7 }

test('the top recurring friction is the last line, and the brief is then exactly BRIEF_MAX_LINES long', () => {
  const text = composeBrief({ delegations: DELEGATIONS, models: sessionModels(LEDGER), mechanical: mechanicalShare(LEDGER), frictions: [FRICTION, { ...FRICTION, signature: 'second', sessions: 2, count: 2 }] }) ?? ''
  const lines = text.split('\n')
  expect(lines).toHaveLength(BRIEF_MAX_LINES)
  expect(lines[5]).toBe('- recurring friction: Owned cleanup remains: [{<Q>: <Q>}] (hook-block, 3 sessions, 7 times)')
  expect(lines.slice(0, 5).join('\n')).toBe(composeBrief({ delegations: DELEGATIONS, models: sessionModels(LEDGER), mechanical: mechanicalShare(LEDGER) }))
})

test('no recurring friction, no line; a friction alone is enough to compose; an absent field is none', () => {
  const base = { delegations: emptyDelegations(), models: [], mechanical: NONE }
  expect(composeBrief({ ...base, frictions: [] })).toBeNull()
  expect(composeBrief(base)).toBeNull()
  expect(composeBrief({ ...base, frictions: [FRICTION] })?.split('\n')).toEqual([
    'Self-calibration (zetetic-insights ledger, last 0 sessions). Measured, not prescribed:',
    '- recurring friction: Owned cleanup remains: [{<Q>: <Q>}] (hook-block, 3 sessions, 7 times)',
  ])
})

test('briefOf counts the frictions of the window sessions only: a session outside the 10 newest does not make a row recur', () => {
  const f = (signature: string) => [{ kind: 'hook-error' as const, signature, count: 1 }]
  const rest = Array.from({ length: 10 }, (_, i) => turn(`s${i + 1}`, 10 + i, 'claude-haiku-5-5', [run('implementation', 4)]))
  const oldest = turn('s00', 1, 'claude-haiku-5-5', [run('implementation', 4)])
  const stored = new Map([['s00', f('x')], ['s1', f('x')], ['s2', f('y')], ['s3', f('y')]])
  const text = briefOf([oldest, ...rest], stored) ?? ''
  expect(text.split('\n').filter((l) => l.startsWith('- recurring friction'))).toEqual(['- recurring friction: y (hook-error, 2 sessions, 2 times)'])
  expect(briefOf([oldest, ...rest]) ?? '').not.toMatch(/recurring friction/)
})

test('a friction line is cut to BRIEF_LINE_CAP like the others', () => {
  const text = composeBrief({ delegations: emptyDelegations(), models: [], mechanical: NONE, frictions: [{ ...FRICTION, signature: 'z'.repeat(190) }] }) ?? ''
  expect(text.split('\n')[1]).toHaveLength(BRIEF_LINE_CAP)
})
