// The learning curve of each phase: main's failed-call rate over the ledger's turns, in order, and
// where the calibration moved the phase. What the mission-control pane draws; bounded, so the
// state it rides in stays small whatever the ledger holds.

import type { Calibration, Phase, PhaseTrend, TurnRecord } from '../types'

export const TREND_TURNS = 400 // source: own choice, the most recent turns a curve is drawn from
export const TREND_POINTS = 40 // source: own choice, the points of one curve (a pane is ~80 cells)

// Each phase's turns, newest TREND_TURNS, cut into at most TREND_POINTS consecutive buckets of
// equal size; a point is a bucket's errors over its steps. O(records), at most 8 × 40 points.
export const trends = (records: readonly TurnRecord[], changes: Calibration['changes']): PhaseTrend[] => {
  const by = new Map<Phase, { at: number; steps: number; errors: number }[]>()
  for (const r of records.slice(-TREND_TURNS))
    for (const run of r.main) {
      const rows = by.get(run.phase) ?? []
      const last = rows[rows.length - 1]
      if (last !== undefined && last.at === r.at) {
        last.steps += run.steps
        last.errors += run.errors
      } else rows.push({ at: r.at, steps: run.steps, errors: run.errors })
      by.set(run.phase, rows)
    }
  return [...by.entries()]
    .map(([phase, turns]) => {
      const size = Math.ceil(turns.length / TREND_POINTS)
      const points = []
      for (let i = 0; i < turns.length; i += size) {
        const bucket = turns.slice(i, i + size)
        const steps = bucket.reduce((n, t) => n + t.steps, 0)
        const errors = bucket.reduce((n, t) => n + t.errors, 0)
        points.push({ at: bucket[bucket.length - 1]!.at, steps, rate: steps === 0 ? 0 : errors / steps })
      }
      const move = changes[phase]
      return { phase, points, move: move === undefined ? null : { at: move.at, from: move.from, to: move.to } }
    })
    .sort((a, b) => a.phase.localeCompare(b.phase))
}
