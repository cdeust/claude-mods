import { expect, test } from 'claude-code/testing'

import type { InsightsState } from './deps'
import { advisorRow, agentRows, calibrationRow, goalRow, headline, phaseRows, proposalRows } from './insightline'

const INSIGHTS: InsightsState = {
  mode: 'observe',
  turns: 12,
  sessions: 3,
  judgedSessions: 2,
  ledgerError: null,
  facetsError: null,
  phases: [{ phase: 'test', effort: 'medium', steps: 40, errors: 12, sessions: 2, judged: 2, achieved: 1 }],
  trends: [],
  models: [],
  delegations: { total: 0, designed: 0, flags: { overkill: 0, underpowered: 0, undesigned: 0, rerouted: 0 }, recent: [] },
  agents: [{ type: 'zetetic-team-subagents:code-reviewer', runs: 4, steps: 20, errors: 1, models: ['claude-opus-5-5'] }],
  advisor: { heavyTurns: 4, heavyBeforeWrite: 3, heavyAtCompletion: 2, lightTurns: 8, lightWithAdvisor: 1 },
  goals: [{ name: 'calibrate', status: 'active' }],
  goalsError: null,
  calibration: { version: 1, phases: { analysis: 'low' }, evidence: {}, changes: {}, updatedAt: 1 },
  calibrationError: null,
  proposals: [{ phase: 'test', from: 'medium', to: 'high', evidence: '12 failed calls in 40 steps at medium over 2 sessions' }],
  updatedAt: 2,
}

test('the INSIGHTS lines state the ledger, the evidence, the advisor, the calibration and the goals', () => {
  expect(headline(INSIGHTS)).toBe('observe · 12 turns over 3 sessions · 2 judged by /insights')
  expect(phaseRows(INSIGHTS)).toEqual(['test           medium     40 steps  30 % failed  1/2 achieved'])
  expect(calibrationRow(INSIGHTS)).toBe('calibration: analysis low')
  expect(proposalRows(INSIGHTS)).toEqual(['propose test medium → high: 12 failed calls in 40 steps at medium over 2 sessions'])
  expect(advisorRow(INSIGHTS)).toBe(
    'advisor: 3/4 analysis or critical turns consulted it before writing, 2/4 at completion · 1/8 routine turns called it',
  )
  expect(goalRow(INSIGHTS)).toBe('goals: calibrate active')
  expect(agentRows(INSIGHTS, 5)).toEqual(['code-reviewer          4 runs   5 % failed · claude-opus-5-5'])
  expect(calibrationRow({ ...INSIGHTS, calibration: { ...INSIGHTS.calibration, phases: {} }, calibrationError: 'bad' })).toBe(
    'calibration: none, every phase loops at medium · file unreadable: bad',
  )
})
