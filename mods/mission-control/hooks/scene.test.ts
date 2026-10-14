import { expect, test } from 'claude-code/testing'

import { INSIGHTS, PHASES } from './fixture'
import { HISTORY_TURNS, MODEL_ROWS, WINDOW_MS, familyOf, pastTurn, remembered, sceneOf } from './scene'

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

test('the window counts steps by family: main under its models, each shown agent under its own', () => {
  // main: 24 steps on opus; Explore 5 on haiku; code-reviewer 4 on opus.
  expect(sceneOf(PHASES, INSIGHTS, 100_000).models.window).toEqual([{ family: 'haiku', steps: 5 }, { family: 'opus', steps: 28 }])
  // A past turn counts under its own model; the sessions are the insights' own, the last MODEL_ROWS.
  const past = { ...pastTurn(main, 'turn-0000', 100_000), model: 'claude-sonnet-5-5' }
  const next = { ...PHASES, turnId: 'turn-0002', loops: PHASES.loops.filter((l) => l.id === 'main').map((l) => ({ ...l, runs: [{ phase: 'report', effort: 'low', steps: 2, errors: 0, since: 120_000 }] })) } as typeof PHASES
  const scene = sceneOf(next, INSIGHTS, 130_000, [past])
  expect(scene.models.window).toEqual([{ family: 'sonnet', steps: 24 }, { family: 'opus', steps: 2 }])
  expect(scene.models.sessions.map((s) => s.session)).toEqual(['abc10001-aaaa', 'def20002-bbbb'])
  expect(sceneOf(null, null, 5).models).toEqual({ window: [], sessions: [] })
  const many = { ...INSIGHTS, models: Array.from({ length: MODEL_ROWS + 3 }, (_, i) => ({ session: `s${i}`, at: i, steps: [] })) } as unknown as typeof INSIGHTS
  expect(sceneOf(null, many, 5).models.sessions.map((s) => s.session)).toEqual(Array.from({ length: MODEL_ROWS }, (_, i) => `s${i + 3}`))
})

test('familyOf names the family in a model id, empty is unknown', () => {
  expect(['claude-haiku-5-5', 'Claude-SONNET-5', 'claude-opus-5-5[1m]', 'fable-1', 'gpt-9', ''].map(familyOf)).toEqual(['haiku', 'sonnet', 'opus', 'fable', 'other', 'unknown'])
})
