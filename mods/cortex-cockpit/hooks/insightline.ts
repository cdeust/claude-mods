// Pure text of the INSIGHTS panel: what the ledger says per phase, the advisor against the grades,
// the calibration and what the evidence proposes.

import type { InsightsState } from './deps'

const pct = (n: number, of: number): string => (of === 0 ? '—' : `${Math.round((n / of) * 100)} %`)

export const headline = (s: InsightsState): string =>
  `${s.mode} · ${s.turns} turns over ${s.sessions} sessions · ${s.judgedSessions} judged by /insights${
    s.facetsError === null ? '' : ` · facets unreadable: ${s.facetsError}`
  }${s.ledgerError === null ? '' : ` · ledger: ${s.ledgerError}`}`

// `test        medium     40 steps  30 % failed  1/2 achieved`
export const phaseRows = (s: InsightsState): string[] =>
  s.phases.map(
    (p) =>
      `${p.phase.padEnd(14)} ${p.effort.padEnd(7)} ${String(p.steps).padStart(5)} steps ${pct(p.errors, p.steps).padStart(5)} failed  ${
        p.judged === 0 ? 'no outcome yet' : `${p.achieved}/${p.judged} achieved`
      }`,
  )

export const advisorRow = (s: InsightsState): string => {
  const a = s.advisor
  return `advisor: ${a.heavyBeforeWrite}/${a.heavyTurns} analysis or critical turns consulted it before writing, ${a.heavyAtCompletion}/${a.heavyTurns} at completion · ${a.lightWithAdvisor}/${a.lightTurns} routine turns called it`
}

export const calibrationRow = (s: InsightsState): string => {
  const set = Object.entries(s.calibration.phases).map(([p, e]) => `${p} ${e}`)
  const base = set.length === 0 ? 'calibration: none, every phase loops at medium' : `calibration: ${set.join(' · ')}`
  return s.calibrationError === null ? base : `${base} · file unreadable: ${s.calibrationError}`
}

export const proposalRows = (s: InsightsState): string[] =>
  s.proposals.map((p) => `propose ${p.phase} ${p.from} → ${p.to}: ${p.evidence}`)

export const goalRow = (s: InsightsState): string => {
  if (s.goalsError !== null) return `goals: unreadable, ${s.goalsError}`
  if (s.goals.length === 0) return 'goals: none in .zetetic/goals'
  return `goals: ${s.goals.map((g) => `${g.name} ${g.status}`).join(' · ')}`
}

export const agentRows = (s: InsightsState, n: number): string[] =>
  s.agents
    .slice(0, n)
    .map((a) => `${a.type.slice(a.type.lastIndexOf(':') + 1).padEnd(20)} ${String(a.runs).padStart(3)} runs ${pct(a.errors, a.steps).padStart(5)} failed · ${a.models.join(', ')}`)

// The goal the button opens: the calibration is met when no phase still asks to be raised.
export const CALIBRATION_GOAL =
  '/zetetic:goal-loop Calibrate the autopilot from the zetetic-insights ledger: met when /calibrate lists no raise proposal and every phase with at least 40 main steps fails under 25 % of its steps at its calibrated effort.'
