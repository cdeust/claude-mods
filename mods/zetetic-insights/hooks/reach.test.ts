import { expect, test } from 'claude-code/testing'

import type { RunRecord } from '../types'
import { governs, reachOf, withEscalation } from './reach'
import type { Cell } from './rungs'

const cell = (extra: Partial<Cell> = {}): Cell => ({ phase: 'test', effort: 'medium', taskClass: 'critical', session: 's', at: 1, steps: 10, errors: 1, base: 'high', escalated: false, pressured: false, ...extra })

test('the reach of a move is the higher of its two rungs; an unknown effort reaches nothing it could govern', () => {
  expect(reachOf('medium', 'high')).toBe(reachOf('high', 'medium'))
  expect(reachOf('low', 'medium')).toBeLessThan(reachOf('medium', 'high'))
})

test('a run is governed by a move when its base is graded and at least the reach, and no escalation or pressure moved it', () => {
  expect(governs(cell(), 'medium', 'high')).toBe(true)
  expect(governs(cell({ base: 'xhigh' }), 'medium', 'high')).toBe(true) // above the ladder: still capped by it
  expect(governs(cell({ base: 'medium' }), 'medium', 'high')).toBe(false) // never reaches a ceiling above medium
  expect(governs(cell({ base: 'medium' }), 'high', 'medium')).toBe(false) // a lowering from high reaches bases of high only
  expect(governs(cell({ base: 'medium' }), 'low', 'medium')).toBe(true)
  expect(governs(cell({ base: null }), 'medium', 'high')).toBe(false)
  expect(governs(cell({ base: 'unheard-of' }), 'medium', 'high')).toBe(false)
  expect(governs(cell({ escalated: true }), 'medium', 'high')).toBe(false)
  expect(governs(cell({ pressured: true }), 'medium', 'high')).toBe(false)
})

test('the runs at the effort a stuck decision raised to are marked escalated; the others are returned as they were', () => {
  const runs: RunRecord[] = [
    { phase: 'test', effort: 'medium', steps: 9, errors: 3 },
    { phase: 'test', effort: 'high', steps: 1, errors: 0 },
    { phase: 'test', effort: null, steps: 2, errors: 0 },
  ]
  expect(withEscalation(runs, ['high'])).toEqual([runs[0], { ...runs[1]!, escalated: true }, runs[2]])
  expect(withEscalation(runs, [])).toEqual(runs)
})
