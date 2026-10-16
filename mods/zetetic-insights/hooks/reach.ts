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
// (the base, the escalation, the pressure), never on the outcome (a filter on failures would select).

import type { Effort, RunRecord } from '../types'
import type { Cell } from './rungs'

// source: zetetic-autopilot policy.ts RANK, the order of the efforts.
const RANK: Readonly<Record<string, number>> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }

// The lowest base a move between two rungs reaches: the higher of the two.
export const reachOf = (from: Effort, to: Effort): number => Math.max(RANK[from] ?? 0, RANK[to] ?? 0)

// Whether the ceiling decided this run's rung: its base is graded and at least the move's reach, and
// neither the stuck escalation nor pressure moved it (hooks/register.tsx records both with the turn).
export const governs = (c: Cell, from: Effort, to: Effort): boolean => {
  if (c.base === null || c.escalated || c.pressured) return false
  const base = RANK[c.base]
  return base !== undefined && base >= reachOf(from, to)
}

// The runs of a turn that sit on a rung the stuck escalation chose: those whose effort is the `to` of a
// stuck decision of the turn. A run can mix an escalated step with others at that effort (the runs are
// consecutive steps of one phase and effort): it is left out whole, which only costs steps.
export const withEscalation = (runs: readonly RunRecord[], stuckTo: readonly string[]): RunRecord[] =>
  runs.map((r) => (r.effort !== null && stuckTo.includes(r.effort) ? { ...r, escalated: true as const } : r))
