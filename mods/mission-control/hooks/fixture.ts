// A turn as the autopilot and the insights leave it: main through analysis, implementation and
// test, two agents, one advisor call, failed calls in test; two learning curves, one moved.

import type { InsightsState, PhasesState } from './scene'

const run = (phase: string, effort: string | null, steps: number, errors: number, since: number) => ({ phase, effort, steps, errors, since })

export const PHASES = {
  turnId: 'turn-0001-abcd',
  loops: [
    {
      id: 'main', type: 'main', description: 'main loop', model: 'claude-opus-5-5', effort: 'high', phase: 'test', status: 'running',
      runs: [run('analysis', 'high', 6, 0, 0), run('implementation', 'medium', 10, 0, 30_000), run('test', 'medium', 8, 3, 70_000)],
      advisorCalls: 1, wrote: true, updatedAt: 100_000,
    },
    {
      id: 'a1', type: 'Explore', description: 'look around', model: 'claude-haiku-5-5', effort: 'low', phase: 'analysis', status: 'done',
      runs: [run('analysis', 'low', 5, 1, 5_000)], advisorCalls: 0, wrote: false, updatedAt: 40_000,
    },
    {
      id: 'a2', type: 'zetetic-team-subagents:code-reviewer', description: 'review', model: 'claude-opus-5-5', effort: 'high', phase: 'review', status: 'running',
      runs: [run('review', 'high', 4, 0, 80_000)], advisorCalls: 0, wrote: false, updatedAt: 95_000,
    },
  ],
  advisor: { session: 1, uses: [{ at: 20_000, turnId: 'turn-0001-abcd', phase: 'analysis', when: 'before-write', calls: 1 }] },
} as unknown as PhasesState

const points = (rates: number[]) => rates.map((rate, i) => ({ at: (i + 1) * 1000, steps: 10, rate }))

export const INSIGHTS = {
  delegations: {
    total: 9,
    designed: 7,
    flags: { overkill: 2, underpowered: 0, undesigned: 1, rerouted: 0 },
    recent: [
      { at: 1000, type: 'Explore', model: 'claude-opus-5-5', effort: 'high', shape: null, steps: 12, errors: 1, flags: ['overkill'] },
      { at: 2000, type: 'zetetic-team-subagents:code-reviewer', model: 'claude-haiku-5-5', effort: null, shape: null, steps: 4, errors: 0, flags: ['undesigned'] },
    ],
  },
  mechanical: { sessions: 5, heavyReads: 30, heavySteps: 120, unmeasured: 0, share: 0.25 },
  calibration: { version: 1, phases: { test: 'high' }, evidence: {}, changes: {}, updatedAt: 1 },
  models: [
    { session: 'abc10001-aaaa', at: 1000, steps: [{ family: 'sonnet', steps: 30 }, { family: 'opus', steps: 70 }] },
    { session: 'def20002-bbbb', at: 2000, steps: [{ family: 'haiku', steps: 12 }, { family: 'sonnet', steps: 30 }, { family: 'opus', steps: 58 }] },
  ],
  trends: [
    { phase: 'analysis', points: points([0.1, 0.05, 0.08, 0.02]), move: null },
    { phase: 'test', points: points([0.4, 0.35, 0.3, 0.1, 0.05]), move: { at: 3000, from: 'medium', to: 'high' } },
  ],
} as unknown as InsightsState
