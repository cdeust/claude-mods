import { expect, test } from 'claude-code/testing'

import type { LoopPhases, PhasesState } from './deps'
import { advisorText, bandText, loopName, shortModel, strip, trail } from './phaseline'

const loop = (over: Partial<LoopPhases>): LoopPhases => ({
  id: 'main',
  type: 'main',
  description: 'main loop',
  model: 'claude-opus-5-5',
  effort: 'medium',
  phase: null,
  runs: [],
  status: 'running',
  advisorCalls: 0,
  wrote: false,
  updatedAt: 0,
  ...over,
})

const state = (loops: LoopPhases[], uses: PhasesState['advisor']['uses'] = []): PhasesState => ({
  turnId: 't1',
  loops,
  advisor: { session: uses.reduce((n, u) => n + u.calls, 0), uses },
})

test('a model id is shown as family and release', () => {
  expect(shortModel('claude-opus-5-5')).toBe('opus 5.5')
  expect(shortModel('claude-haiku-5-5')).toBe('haiku 5.5')
  expect(shortModel('sonnet')).toBe('sonnet')
})

test('the strip marks the current phase and the ones already visited', () => {
  const l = loop({ phase: 'test', runs: [{ phase: 'analysis', steps: 3, since: 0 }, { phase: 'test', steps: 1, since: 1 }] })
  expect(strip(l).map((c) => `${c.label}:${c.state}`)).toEqual([
    'plan:ahead',
    'anly:visited',
    'dsgn:ahead',
    'impl:ahead',
    'veri:ahead',
    'test:current',
    'revw:ahead',
    'rprt:ahead',
  ])
  expect(trail(l)).toBe('anly 3 › test 1')
})

test('an agent is named by its type and its task', () => {
  expect(loopName(loop({ id: 'a1', type: 'zetetic-team-subagents:code-reviewer', description: 'review #10' }))).toBe('code-reviewer · review #10')
  expect(loopName(loop({}))).toBe('main')
})

test("the band names main's phase, each running agent's, and the turn's advisor calls", () => {
  const s = state(
    [
      loop({ phase: 'implementation' }),
      loop({ id: 'a1', type: 'zetetic-team-subagents:code-reviewer', phase: 'review' }),
      loop({ id: 'a2', type: 'Explore', phase: 'analysis', status: 'done' }),
    ],
    [{ at: 1, turnId: 't1', phase: 'analysis', when: 'before-write', calls: 1 }],
  )
  expect(bandText(s)).toBe('phase · main implementation · code-reviewer review · advisor 1 this turn')
  expect(bandText(state([]))).toBe(undefined)
  expect(bandText(state([loop({ phase: 'report', status: 'done' })]))).toBe('phase · main idle (last report) · advisor 0 this turn')
})

test('the advisor line counts calls by when they came', () => {
  expect(advisorText(state([]))).toBe('advisor: not called this session')
  const s = state([], [
    { at: 1, turnId: 't1', phase: 'analysis', when: 'before-write', calls: 1 },
    { at: 2, turnId: 't1', phase: 'report', when: 'at-completion', calls: 1 },
  ])
  expect(advisorText(s)).toBe('advisor: 2 calls this session · 1 before writing · 0 after · 1 at completion (last 2 steps)')
})
