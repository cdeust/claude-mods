import { expect, test } from 'claude-code/testing'

import type { Move, Phase, Proposal, Verdict } from '../types'
import { effectLine, effectOf, effectsOf, movesWith, snapshotOf } from './effect'
import { emptyCalibration } from './learn'
import type { Cell } from './rungs'

const cell = (effort: string, session: string, at: number, steps: number, errors: number, taskClass = 'bugfix', phase: Phase = 'review'): Cell => ({ phase, effort, taskClass, session, at, steps, errors })
const proposal = (to: 'low' | 'high', from: 'medium' | 'low' = 'medium', phase: Phase = 'review'): Proposal => ({ phase, from, to, evidence: 'e', rate: { errors: 0, steps: 1, lo: 0, hi: 1 }, reference: { errors: 0, steps: 1, lo: 0, hi: 1 } })
const AT = 100

// Before the move: review at medium in bugfix and critical, five sessions; after: review at low in bugfix only.
const before = (steps: number, errors: number): Cell[] => ['s1', 's2', 's3', 's4', 's5'].flatMap((s, i) => [cell('medium', s, 10 + i, steps, errors), cell('medium', s, 20 + i, steps, errors, 'critical')])
const after = (steps: number, errors: number): Cell[] => ['s6', 's7', 's8', 's9', 's10'].map((s, i) => cell('low', s, 200 + i, steps, errors))
const verdicts = (ids: string[], v: Verdict): Map<string, Verdict> => new Map(ids.map((s) => [s, v]))

test('a snapshot is the phase runs at one effort by task class, with each session outcome under its 8-character key', () => {
  const snap = snapshotOf([cell('medium', 'abcdef123456', 1, 10, 2), cell('medium', 'abcdef123456', 2, 5, 0, 'critical'), cell('low', 'zzz', 3, 9, 9)], verdicts(['abcdef123456'], 'achieved'), 'review', 'medium')
  expect(snap).toEqual({ byClass: { bugfix: { steps: 10, errors: 2 }, critical: { steps: 5, errors: 0 } }, sessions: { abcdef12: 'achieved' } })
})

test('a move freezes the runs before it; the previous move of the same phase is closed with the runs it governed', () => {
  const cells = [...before(20, 4), cell('low', 's6', 150, 10, 1), cell('low', 's6', 160, 10, 1)]
  const first = movesWith(emptyCalibration(), [proposal('low')], AT, cells, new Map())
  expect(first.length).toBe(1)
  expect(first[0]).toMatchObject({ phase: 'review', at: AT, from: 'medium', to: 'low', post: null })
  expect(first[0]!.pre.byClass).toEqual({ bugfix: { steps: 100, errors: 20 }, critical: { steps: 100, errors: 20 } })
  const second = movesWith({ ...emptyCalibration(), moves: first }, [proposal('high', 'low')], 300, cells, new Map())
  expect(second.length).toBe(2)
  expect(second[0]!.post?.byClass).toEqual({ bugfix: { steps: 20, errors: 2 } })
  expect(second[1]).toMatchObject({ from: 'low', to: 'high', post: null })
  // another phase's proposal leaves the open move open
  expect(movesWith({ ...emptyCalibration(), moves: first }, [proposal('high', 'medium', 'test')], 300, cells, new Map())[0]!.post).toBeNull()
})

test('the move is credited with harm only on a comparison of the same phase and the same task classes', () => {
  const m = movesWith(emptyCalibration(), [proposal('low')], AT, before(40, 2), new Map())[0]!
  const effect = effectOf(m, after(40, 14), new Map())
  expect(effect.classes).toEqual(['bugfix']) // critical ran only before: not compared
  expect(effect.preSide).toMatchObject({ steps: 200, errors: 10 })
  expect(effect.postSide).toMatchObject({ steps: 200, errors: 70 })
  expect(Math.abs(effect.failed.d - 0.3)).toBeLessThan(0.001)
  expect(effect.failed.lo).toBeGreaterThan(0)
  expect(effect.credit).toBe('harm')
})

test('fewer failed calls with confidence is a benefit; the same rate is inconclusive; no steps after is insufficient', () => {
  const m = movesWith(emptyCalibration(), [proposal('low')], AT, before(40, 12), new Map())[0]!
  expect(effectOf(m, after(40, 2), new Map())).toMatchObject({ credit: 'benefit' })
  expect(effectOf(m, after(40, 12), new Map())).toMatchObject({ credit: 'inconclusive' })
  expect(effectOf(m, [], new Map()).credit).toBe('insufficient')
  expect(effectOf(m, [cell('medium', 's6', 200, 40, 0)], new Map()).credit).toBe('insufficient') // the rung moved to never ran
})

test('the pre statistics survive the ledger trimming the runs they came from', () => {
  const m = movesWith(emptyCalibration(), [proposal('low')], AT, before(40, 2), new Map())[0]!
  const trimmed = after(40, 2) // the pre runs are gone from the ledger
  expect(effectOf(m, trimmed, new Map()).preSide.steps).toBe(200)
})

test('the outcome is compared on judged sessions; a session with runs on both sides belongs to neither', () => {
  const pre = verdicts(['s1', 's2', 's3', 's4', 's5'], 'achieved')
  const m = movesWith(emptyCalibration(), [proposal('low')], AT, before(40, 2), pre)[0]!
  const post = new Map<string, Verdict>([...verdicts(['s6', 's7', 's8', 's9', 's10'], 'not-achieved'), ['s1', 'not-achieved']])
  const straddle = [...after(40, 2), cell('low', 's1', 300, 10, 0)]
  const effect = effectOf(m, straddle, post)
  expect(effect.preSide.judged).toBe(4) // s1 dropped from the pre side
  expect(effect.postSide.judged).toBe(5) // and from the post side
  expect(Math.abs((effect.outcome?.d ?? 0) + 1)).toBeLessThan(1e-9)
  expect(effect.outcome?.hi).toBeLessThan(0)
  expect(effect.credit).toBe('harm')
  expect(effectOf(m, after(40, 2), new Map()).outcome).toBeNull() // no judged session after: no outcome claim
})

test('effectsOf credits each phase by its last move; the line states the delta in points with its interval and the steps', () => {
  const first = movesWith(emptyCalibration(), [proposal('low')], AT, before(40, 12), new Map())
  const moves: Move[] = [...first]
  const { effects, credits } = effectsOf(moves, after(40, 2), new Map())
  expect(credits.get('review')).toBe('benefit')
  expect(effectLine(effects[0]!)).toMatch(/^review medium -> low: failed calls -2\d pts \[-\d+, -\d+\] \(200 -> 200 steps\); benefit$/)
})
