import { expect, test } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import { TREND_POINTS, TREND_TURNS, trends } from './trend'

const turn = (at: number, main: TurnRecord['main']): TurnRecord => ({
  session: 's',
  turnId: `t${at}`,
  at,
  taskClass: null,
  main,
  agents: [],
  advisor: { calls: 0, beforeWrite: 0, atCompletion: 0 },
  stuck: 0,
})

test("a phase's curve is its failed-call rate per turn, two runs of one turn counted as one", () => {
  const records = [
    turn(1, [{ phase: 'test', effort: 'medium', steps: 4, errors: 2 }, { phase: 'test', effort: 'high', steps: 4, errors: 0 }]),
    turn(2, [{ phase: 'test', effort: 'high', steps: 5, errors: 0 }, { phase: 'analysis', effort: 'low', steps: 1, errors: 1 }]),
  ]
  const moved = { test: { at: 1, from: 'medium' as const, to: 'high' as const } }
  expect(trends(records, moved)).toEqual([
    { phase: 'analysis', points: [{ at: 2, steps: 1, rate: 1 }], move: null },
    { phase: 'test', points: [{ at: 1, steps: 8, rate: 0.25 }, { at: 2, steps: 5, rate: 0 }], move: { at: 1, from: 'medium', to: 'high' } },
  ])
})

test('a curve has at most TREND_POINTS points over the newest TREND_TURNS turns', () => {
  const records = Array.from({ length: TREND_TURNS + 100 }, (_, i) => turn(i, [{ phase: 'test', effort: 'medium', steps: 2, errors: i % 2 }]))
  const [t] = trends(records, {})
  expect(t!.points.length).toBeLessThanOrEqual(TREND_POINTS)
  expect(t!.points[t!.points.length - 1]!.at).toBe(TREND_TURNS + 99)
  expect(t!.points[0]!.steps).toBe(2 * (TREND_TURNS / TREND_POINTS))
  expect(t!.points.every((p) => p.rate === 0.25)).toBe(true)
})
