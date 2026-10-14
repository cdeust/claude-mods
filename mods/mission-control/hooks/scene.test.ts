import { expect, test } from 'claude-code/testing'

import { PHASES } from './fixture'
import { HISTORY_TURNS, WINDOW_MS, pastTurn, remembered, sceneOf } from './scene'

const main = PHASES.loops.find((l) => l.id === 'main')!

test("main's past turns stay on its lane after the autopilot starts a new turn, inside the window", () => {
  const past = pastTurn(main, 'turn-0001-abcd', 100_000)
  // The next turn: main's row starts afresh with one report run; the agents ended before it.
  const next = { ...PHASES, turnId: 'turn-0002', loops: PHASES.loops.map((l) => (l.id === 'main' ? { ...l, runs: [{ phase: 'report', effort: 'low', steps: 1, errors: 0, since: 120_000 }] } : { ...l, status: 'done' })) } as typeof PHASES
  const scene = sceneOf(next, null, 130_000, [past])
  const lane = scene.lanes.find((l) => l.id === 'main')!
  expect(lane.segments.map((s) => s.phase)).toEqual(['analysis', 'implementation', 'test', 'report'])
  expect(scene.lanes.map((l) => l.label)).toEqual(['main', 'Explore', 'code-reviewer'])
  expect(lane.advisor).toEqual([20_000])
  // Past the window, the old turn and the agents are gone; the current turn stays.
  const later = sceneOf(next, null, 120_000 + WINDOW_MS + 1, [past])
  expect(later.lanes.map((l) => l.label)).toEqual(['main'])
  expect(later.lanes[0]!.segments.map((s) => s.phase)).toEqual(['report'])
})

test('the history keeps one record per turn, the newest HISTORY_TURNS', () => {
  let h = remembered([], pastTurn(main, 't0', 1))
  h = remembered(h, { ...pastTurn(main, 't0', 2) })
  expect(h.length).toBe(1)
  for (let i = 1; i <= HISTORY_TURNS + 5; i++) h = remembered(h, pastTurn(main, `t${i}`, i))
  expect(h.length).toBe(HISTORY_TURNS)
  expect(h[h.length - 1]!.turnId).toBe(`t${HISTORY_TURNS + 5}`)
})
