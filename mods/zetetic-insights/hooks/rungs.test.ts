import { expect, test } from 'claude-code/testing'

import type { Calibration, Effort, Phase, TurnRecord, Verdict } from '../types'
import { emptyCalibration } from './learn'
import { type Cell, UNCLASSIFIED, cellsOf, decisions, phaseStats, pool } from './rungs'

const cell = (phase: Phase, effort: string, session: string, steps: number, errors: number, taskClass = 'bugfix', at = 1): Cell => ({ phase, effort, taskClass, session, at, steps, errors })
const sessions = ['a', 'b', 'c', 'd']
// A phase over the four sessions at one rung: `steps` and `errors` in each.
const over = (phase: Phase, effort: string, steps: number, errors: number, ids = sessions, taskClass = 'bugfix'): Cell[] => ids.map((s) => cell(phase, effort, s, steps, errors, taskClass))
const achieved = (ids: string[], verdict: Verdict = 'achieved'): Map<string, Verdict> => new Map(ids.map((s) => [s, verdict]))
const calibrated = (phases: Partial<Record<Phase, Effort>>): Calibration => ({ ...emptyCalibration(), phases })

test('a run becomes a cell with the effort it had, its task class and its session; no effort and no class are named', () => {
  const rec = { session: 's', turnId: 't', at: 5, taskClass: null, main: [{ phase: 'test', effort: null, steps: 3, errors: 1 }], agents: [], advisor: { calls: 0, beforeWrite: 0, atCompletion: 0 }, stuck: 0 } as TurnRecord
  expect(cellsOf([rec])).toEqual([{ phase: 'test', effort: 'default', taskClass: UNCLASSIFIED, session: 's', at: 5, steps: 3, errors: 1 }])
})

test('rows keep the runs of every rung, pre-move ones included, each with its Wilson interval and whether it is resolved', () => {
  const cells = [...over('implementation', 'low', 30, 3), ...over('implementation', 'medium', 5, 1)]
  const rows = phaseStats(cells, achieved(['a', 'b']))
  expect(rows.map((r) => [r.effort, r.steps, r.errors, r.sessions, r.judged, r.achieved, r.resolved])).toEqual([
    ['low', 120, 12, 4, 2, 2, true],
    ['medium', 20, 4, 4, 2, 2, false],
  ])
  expect(rows[0]!.lo).toBeLessThan(0.1)
  expect(rows[0]!.hi).toBeGreaterThan(0.1)
})

test('a phase failing confidently more than the others at its rung is raised, with both intervals in the evidence', () => {
  const cells = [...over('test', 'medium', 30, 9), ...over('analysis', 'medium', 30, 1)]
  const { proposals, findings } = decisions(cells, new Map(), emptyCalibration())
  // The quiet phase is described too: it fails less than the rest, but no session of it was judged.
  expect(findings.map((f) => [f.phase, f.kind])).toEqual([['analysis', 'unresolved']])
  expect(proposals.length).toBe(1)
  expect(proposals[0]).toMatchObject({ phase: 'test', from: 'medium', to: 'high', rate: { errors: 36, steps: 120 }, reference: { errors: 4, steps: 120 } })
  expect(proposals[0]!.rate.lo).toBeGreaterThan(proposals[0]!.reference.hi)
  expect(proposals[0]!.evidence).toMatch(/^test: 36\/120 steps failed at medium \(30% \[\d+%-\d+%\]\) against 4\/120 in the other phases at medium \(3% \[\d+%-\d+%\]\); 4 sessions, the verdict holds without any one of them$/)
})

test('the old rule raised 12 failures in 40 steps; 40 steps cannot resolve 30% to +-10 points, so it no longer does', () => {
  const cells = [cell('test', 'medium', 'a', 40, 12), ...over('analysis', 'medium', 30, 1)]
  const { proposals, findings } = decisions(cells, new Map(), emptyCalibration())
  expect(proposals).toEqual([])
  expect(findings.filter((f) => f.phase === 'test')).toEqual([{ phase: 'test', effort: 'medium', kind: 'unresolved', note: expect.stringMatching(/^12\/40 steps failed at medium \(30% \[\d+%-\d+%\]\): wider than \+-10%$/) }])
})

test('a verdict that rests on one session is not a move: it does not survive that session being left out', () => {
  const cells = [cell('test', 'medium', 'a', 120, 36), ...over('analysis', 'medium', 30, 1)]
  const { proposals, findings } = decisions(cells, new Map(), emptyCalibration())
  expect(proposals).toEqual([])
  expect(findings.filter((f) => f.phase === 'test').map((f) => f.kind)).toEqual(['unstable'])
})

test('no other phase at the rung, no reference: the phase is described, not moved', () => {
  const { proposals, findings } = decisions(over('test', 'medium', 30, 9), new Map(), emptyCalibration())
  expect(proposals).toEqual([])
  expect(findings.map((f) => f.kind)).toEqual(['no-reference'])
})

test('a phase failing confidently less than the others is lowered only when its sessions were achieved with confidence', () => {
  const cells = [...over('review', 'medium', 40, 0), ...over('test', 'medium', 40, 10)]
  const ids = sessions
  const lowered = decisions(cells, achieved(ids), emptyCalibration())
  // review fails less than test, which in turn fails more than review: both moves are read from the same rows.
  expect(lowered.proposals.map((p) => [p.phase, p.to])).toEqual([['review', 'low'], ['test', 'high']])
  expect(lowered.proposals[0]!.evidence).toMatch(/4\/4 judged sessions achieved$/)
  const unjudged = decisions(cells, new Map(), emptyCalibration())
  expect(unjudged.proposals.map((p) => p.phase)).toEqual(['test'])
  expect(unjudged.findings.map((f) => [f.phase, f.kind])).toEqual([['review', 'unresolved']])
  expect(decisions(cells, achieved(ids, 'not-achieved'), emptyCalibration()).proposals.map((p) => p.phase)).toEqual(['test'])
})

test('the rung that ran is read: a phase that ran only at low is not moved by a medium ceiling, and the finding says the ceiling cannot reach it', () => {
  const cells = [...over('implementation', 'low', 40, 16), ...over('report', 'low', 40, 2)]
  const { proposals, findings } = decisions(cells, new Map(), emptyCalibration())
  expect(proposals).toEqual([])
  expect(findings).toEqual([{ phase: 'implementation', effort: 'low', kind: 'unreachable', note: expect.stringMatching(/cannot lift them, their effort is the grade's base/) }])
  // With the ceiling at low the same rows are the ones that govern: the move is raised from low.
  const atLow = decisions(cells, new Map(), calibrated({ implementation: 'low', report: 'low' }))
  expect(atLow.proposals.map((p) => [p.phase, p.from, p.to])).toEqual([['implementation', 'low', 'medium']])
})

test('a raise is held back when the rung above, in the task classes both ran, fails confidently more', () => {
  const cells = [...over('test', 'medium', 30, 9), ...over('analysis', 'medium', 30, 1), ...over('test', 'high', 30, 20)]
  const { proposals } = decisions(cells, new Map(), emptyCalibration())
  expect(proposals).toEqual([])
  // In a task class the two rungs do not share, the neighbour is not compared.
  const apart = [...over('test', 'medium', 30, 9, sessions, 'bugfix'), ...over('analysis', 'medium', 30, 1), ...over('test', 'high', 30, 20, sessions, 'critical')]
  expect(decisions(apart, new Map(), emptyCalibration()).proposals.map((p) => p.to)).toEqual(['high'])
})

test("undoing a phase's last move needs that move's measured effect to be harm", () => {
  const moved: Calibration = { ...calibrated({ review: 'low' }), changes: { review: { at: 5, from: 'medium', to: 'low' } } }
  const cells = [...over('review', 'low', 40, 20), ...over('test', 'low', 40, 1)] // review fails at low: raise back to medium
  const held = decisions(cells, new Map(), moved, new Map([['review', 'inconclusive']]))
  expect(held.proposals).toEqual([])
  expect(held.findings.map((f) => f.kind)).toEqual(['held'])
  const harmed = decisions(cells, new Map(), moved, new Map([['review', 'harm']]))
  expect(harmed.proposals.map((p) => [p.phase, p.from, p.to])).toEqual([['review', 'low', 'medium']])
})

test('pool sums steps and errors and names the sessions once', () => {
  expect(pool([cell('test', 'low', 'a', 3, 1), cell('test', 'low', 'a', 2, 0), cell('test', 'low', 'b', 5, 5)])).toEqual({ steps: 10, errors: 6, sessions: ['a', 'b'] })
})
