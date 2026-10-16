// Which steps a move of a phase's ceiling can have changed. Pure.
//
// What puts a main step on a rung (zetetic-autopilot policy.ts effortFor, register.tsx turn.step):
//   rung = min(graded base, ceiling)          for the tool-loop steps of a turn, no pressure
//   rung = escalate(rung)                     after 3 failed calls in a row (the stuck escalation)
//   rung = low                                 under quota or context pressure
// The ceiling is the only one of these a move changes. Raising it from `from` to `to` lifts exactly the
// steps whose base is at least `to` (they were capped at `from`); lowering it from `from` to `to` drops
// exactly those whose base is at least `from`. Every other step sits on its rung for another reason and
// would sit there with or without the move: counted on either side, it is a different population, not an
// effect. So a move is compared on the steps it governed, conditioned on the causes that are recorded
// (the base, the escalation, the pressure, whether the autopilot applied anything), never on the outcome
// (a filter on failures would select).

import type { Effort, RunRecord } from '../types'
import type { Cell } from './rungs'

// source: zetetic-autopilot policy.ts RANK, the order of the efforts.
const RANK: Readonly<Record<string, number>> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }

// The lowest base a move between two rungs reaches: the higher of the two.
export const reachOf = (from: Effort, to: Effort): number => Math.max(RANK[from] ?? 0, RANK[to] ?? 0)

// Whether the ceiling decided this run's rung: its base is graded and at least the move's reach, neither
// the stuck escalation nor pressure moved it, the autopilot enforced its policy in the turn, and its
// decision log kept every decision of the turn (hooks/register.tsx records all of these with the turn).
export const governs = (c: Cell, from: Effort, to: Effort): boolean => {
  if (c.base === null || c.escalated || c.pressured || c.unenforced || c.decisionsLost) return false
  const base = RANK[c.base]
  return base !== undefined && base >= reachOf(from, to)
}

// A main run as the autopilot's phases row has it: `since` is when its first step answered.
export type TimedRun = RunRecord & { since: number }
// A stuck decision the autopilot applied: when it was taken and the effort it raised the next step to.
export type Stuck = { at: number; to: string }

// The runs that can hold the step a stuck decision raised. The autopilot (register.tsx `turn.step`) takes
// the decision's `at` before it sends that one step and stamps a run's `since` after its first step
// answers (`tracked`), and a step joins the last run when its phase and effort are the same (phases.ts
// `stepped`). So the raised step, sent at `to`, is in the run active at `at` (when that run is at `to`)
// or opens the first run after it. Both are returned when both are at `to`: which one holds it is not
// recorded, and neither is counted. The step's phase is the one it was classed in, not the phase named
// in the decision's subject (the phase before the step).
const raisedBy = (runs: readonly TimedRun[], d: Stuck): number[] => {
  const active = runs.findLastIndex((r) => r.since <= d.at)
  const opened = runs.findIndex((r) => r.since > d.at)
  return [active, opened].filter((i) => i >= 0 && runs[i]!.effort === d.to)
}

// The runs of a turn with the run of each step the stuck escalation raised marked `escalated`. The run is
// left out whole (its other steps are at that effort for another reason), which only costs steps; every
// other run, whatever its effort, is returned as it was.
export const withEscalation = (runs: readonly TimedRun[], stuck: readonly Stuck[]): RunRecord[] => {
  const marked = new Set(stuck.flatMap((d) => raisedBy(runs, d)))
  return runs.map(({ since: _, ...r }, i) => (marked.has(i) ? { ...r, escalated: true as const } : r))
}
