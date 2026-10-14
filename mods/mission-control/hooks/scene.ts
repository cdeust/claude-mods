// What the pane shows, as data both painters draw: the turn's lanes (main and its agents) over
// time, the effort each phase runs at, and each phase's learning curve. Pure: the same state at
// the same instant is the same scene.

import type { PluginState } from 'claude-code'

export type PhasesState = PluginState['zetetic-autopilot']['phases']
export type InsightsState = PluginState['zetetic-insights']['insights']
type LoopPhases = PhasesState['loops'][number]
export type Phase = NonNullable<LoopPhases['phase']>

export const MAX_LANES = 8 // source: own choice, main and the seven agents seen last
const LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const

// An effort as a bar height, 1 (low) to 4 (xhigh or max); 0 when the engine sent none.
export const rung = (effort: string | null): number => {
  const i = LADDER.indexOf(effort as (typeof LADDER)[number])
  return i < 0 ? 0 : Math.min(i + 1, 4)
}

export type Segment = { phase: Phase; effort: string | null; t0: number; t1: number; steps: number; errors: number }
export type Lane = { id: string; label: string; model: string; isRunning: boolean; segments: Segment[]; advisor: number[] }
export type Gauge = { phase: Phase; calibrated: string | null; ran: string | null }
export type Curve = { phase: Phase; rates: number[]; moveAt: number | null; move: string | null }
export type Scene = { t0: number; t1: number; turnId: string | null; lanes: Lane[]; gauges: Gauge[]; curves: Curve[] }

// A loop's runs as segments: each run lasts until the next one starts, the last until the loop's
// last step (or now, while it runs).
const segmentsOf = (loop: LoopPhases, now: number): Segment[] =>
  loop.runs.map((r, i) => ({
    phase: r.phase,
    effort: r.effort,
    t0: r.since,
    t1: loop.runs[i + 1]?.since ?? (loop.status === 'running' ? now : Math.max(loop.updatedAt, r.since)),
    steps: r.steps,
    errors: r.errors,
  }))

const shortType = (type: string): string => type.split(':').pop() ?? type

// Main's row of this turn, and the agents that ran during it (the newest ones first to be kept);
// before main's first step, the agents seen last.
const lanesOf = (phases: PhasesState, now: number): Lane[] => {
  const main = phases.loops.find((l) => l.id === 'main')
  const start = main?.runs[0]?.since
  const agents = phases.loops
    .filter((l) => l.id !== 'main' && l.runs.length > 0 && (start === undefined || l.updatedAt >= start))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, main === undefined || main.runs.length === 0 ? MAX_LANES : MAX_LANES - 1)
    .reverse()
  const ordered = main !== undefined && main.runs.length > 0 ? [main, ...agents] : agents
  const turnUses = phases.advisor.uses.filter((u) => u.turnId === phases.turnId)
  return ordered.map((l) => ({
    id: l.id,
    label: l.id === 'main' ? 'main' : shortType(l.type),
    model: l.model,
    isRunning: l.status === 'running',
    segments: segmentsOf(l, now),
    advisor: l.id === 'main' ? turnUses.map((u) => u.at) : [],
  }))
}

const gaugesOf = (main: LoopPhases | undefined, insights: InsightsState | null): Gauge[] => {
  const calibrated = insights?.calibration.phases ?? {}
  const seen = new Set<Phase>([...(Object.keys(calibrated) as Phase[]), ...(main?.runs.map((r) => r.phase) ?? [])])
  return [...seen].sort().map((phase) => ({
    phase,
    calibrated: calibrated[phase] ?? null,
    ran: [...(main?.runs ?? [])].reverse().find((r) => r.phase === phase)?.effort ?? null,
  }))
}

const curvesOf = (insights: InsightsState | null): Curve[] =>
  (insights?.trends ?? [])
    .filter((t) => t.points.length >= 2)
    .map((t) => ({
      phase: t.phase,
      rates: t.points.map((p) => p.rate),
      // The first point recorded after the move; a move newer than every point sits on the last.
      moveAt: t.move === null ? null : ((i) => (i < 0 ? t.points.length - 1 : i))(t.points.findIndex((p) => p.at > t.move!.at)),
      move: t.move === null ? null : `${t.move.from} → ${t.move.to}`,
    }))

export const sceneOf = (phases: PhasesState | null, insights: InsightsState | null, now: number): Scene => {
  const lanes = phases === null ? [] : lanesOf(phases, now)
  const starts = lanes.flatMap((l) => l.segments.map((s) => s.t0))
  const ends = lanes.flatMap((l) => l.segments.map((s) => s.t1))
  return {
    t0: starts.length === 0 ? now : Math.min(...starts),
    t1: ends.length === 0 ? now : Math.max(now, ...ends),
    turnId: phases?.turnId ?? null,
    lanes,
    gauges: gaugesOf(phases?.loops.find((l) => l.id === 'main'), insights),
    curves: curvesOf(insights),
  }
}

// A time as a column of a track `width` cells (or pixels) wide.
export const columnOf = (scene: Scene, t: number, width: number): number =>
  scene.t1 <= scene.t0 ? 0 : Math.min(width - 1, Math.max(0, Math.floor(((t - scene.t0) / (scene.t1 - scene.t0)) * width)))
