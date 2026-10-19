import { expect, test } from 'claude-code/testing'

import { type TimedRun, governs, inferred, reachOf, withEscalation } from './reach'
import type { Cell } from './rungs'

const cell = (extra: Partial<Cell> = {}): Cell => ({ phase: 'test', effort: 'medium', taskClass: 'critical', session: 's', at: 1, steps: 10, errors: 1, base: 'high', escalated: false, pressured: false, unenforced: false, decisionsLost: false, ...extra })

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
  expect(governs(cell({ unenforced: true }), 'medium', 'high')).toBe(false) // the autopilot applied no rung
  expect(governs(cell({ decisionsLost: true }), 'medium', 'high')).toBe(false) // which runs it escalated is not known
})

// The autopilot's `turn.step` takes a stuck decision's `at` before the step is sent and stamps the run
// (`since`) after it answers: the raised step is in the run active at `at`, or in the first run opened after it.
const runs: TimedRun[] = [
  { phase: 'implementation', effort: 'high', steps: 10, errors: 4, since: 1 },
  { phase: 'test', effort: 'medium', steps: 9, errors: 3, since: 5 },
  { phase: 'test', effort: 'high', steps: 1, errors: 0, since: 9 },
  { phase: 'review', effort: 'high', steps: 4, errors: 0, since: 12 },
]
const plain = runs.map(({ since: _, ...r }) => r)

test('the run holding the step a stuck decision raised is marked escalated; another run at that effort is not', () => {
  // test got stuck at medium (decision at 8), its next step ran at high: implementation and review also ran at high, untouched
  expect(withEscalation(runs, [{ at: 8, to: 'high' }])).toEqual([plain[0], plain[1], { ...plain[2]!, escalated: true }, plain[3]])
  expect(withEscalation(runs, [])).toEqual(plain)
})

test('each stuck decision of a turn marks the run of its own step', () => {
  const twice: TimedRun[] = [
    { phase: 'test', effort: 'medium', steps: 9, errors: 3, since: 1 },
    { phase: 'test', effort: 'high', steps: 1, errors: 0, since: 4 },
    { phase: 'analysis', effort: 'medium', steps: 9, errors: 3, since: 6 },
    { phase: 'analysis', effort: 'high', steps: 1, errors: 0, since: 9 },
  ]
  expect(withEscalation(twice, [{ at: 3, to: 'high' }, { at: 8, to: 'high' }]).map((r) => r.escalated === true)).toEqual([false, true, false, true])
})

test('a raised step that may have joined the run active at the decision marks that run too: neither candidate is counted', () => {
  // the run active at 8 is already at high in its phase: the raised step may have joined it or opened the next run
  const merged: TimedRun[] = [
    { phase: 'test', effort: 'high', steps: 6, errors: 3, since: 5 },
    { phase: 'review', effort: 'high', steps: 2, errors: 0, since: 10 },
    { phase: 'report', effort: 'high', steps: 1, errors: 0, since: 14 },
  ]
  expect(withEscalation(merged, [{ at: 8, to: 'high' }]).map((r) => r.escalated === true)).toEqual([true, true, false])
  // a run whose effort is not the one raised to cannot hold the raised step
  expect(withEscalation(merged, [{ at: 8, to: 'medium' }]).map((r) => r.escalated === true)).toEqual([false, false, false])
})

// Autopilot 0.8.0 counts the raised steps on the run each landed in (PhaseRun.escalated): read as observed.
test('a run the autopilot counted a raised step on is marked from the count, with no decision', () => {
  const counted: TimedRun[] = [
    { phase: 'test', effort: 'medium', steps: 9, errors: 3, since: 5, observed: 0 },
    { phase: 'test', effort: 'high', steps: 2, errors: 0, since: 9, observed: 1 },
    { phase: 'review', effort: 'high', steps: 4, errors: 0, since: 12, observed: 0 },
  ]
  const out = withEscalation(counted, [])
  expect(out.map((r) => r.escalated === true)).toEqual([false, true, false])
  expect(out[1]).not.toHaveProperty('observed')
})

test('a counted run is never placed by time: a decision joined to a run counted 0 marks nothing', () => {
  const counted: TimedRun[] = [
    { phase: 'test', effort: 'medium', steps: 9, errors: 3, since: 5, observed: 0 },
    { phase: 'test', effort: 'high', steps: 1, errors: 0, since: 9, observed: 0 },
  ]
  expect(withEscalation(counted, [{ at: 8, to: 'high' }]).map((r) => r.escalated === true)).toEqual([false, false])
})

test('a run recorded before the count is still placed by the time join, beside a counted one', () => {
  const mixed: TimedRun[] = [
    { phase: 'test', effort: 'medium', steps: 9, errors: 3, since: 5 },
    { phase: 'test', effort: 'high', steps: 1, errors: 0, since: 9 },
    { phase: 'review', effort: 'high', steps: 4, errors: 0, since: 12, observed: 0 },
  ]
  expect(withEscalation(mixed, [{ at: 8, to: 'high' }]).map((r) => r.escalated === true)).toEqual([false, true, false])
})

test('only a run without the count needs the decision log', () => {
  expect(inferred([{ observed: 0 }, { observed: 2 }])).toBe(false)
  expect(inferred([{ observed: 0 }, {}])).toBe(true)
})
