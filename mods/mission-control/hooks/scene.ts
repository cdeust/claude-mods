// What the pane shows, as data both painters draw: the turn's lanes (main and its agents) over
// time, the effort each phase runs at, and each phase's learning curve. Pure: the same state at
// the same instant is the same scene.

import type { PluginState } from 'claude-code'

import type { PastTurn } from '../types'

export type PhasesState = PluginState['zetetic-autopilot']['phases']
export type InsightsState = PluginState['zetetic-insights']['insights']
type LoopPhases = PhasesState['loops'][number]
export type Phase = NonNullable<LoopPhases['phase']>

export const MAX_LANES = 8 // source: own choice, main and the seven agents seen last
export const WINDOW_MS = 10 * 60_000 // source: own choice, the recent past the lanes span
export const HISTORY_TURNS = 20 // source: own choice, main's past turns kept for the window
export const IDLE_MS = 20_000 // source: own choice, a pause this long is cut from the time axis
const CUT_SHARE = 0.04 // source: own choice, the room one cut takes, as a share of the active time
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
// The stretches of time something ran in; a pause of IDLE_MS or more between them is cut from the
// axis, so a turn of seconds after minutes of reading does not shrink to a sliver.
export type Span = { t0: number; t1: number }
export type Scene = { t0: number; t1: number; spans: Span[]; turnId: string | null; lanes: Lane[]; gauges: Gauge[]; curves: Curve[] }

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

// Main's turn as it completed, kept because the autopilot starts main's row afresh each turn.
export const pastTurn = (main: LoopPhases, turnId: string, now: number): PastTurn => ({
  turnId,
  runs: segmentsOf(main, now).map((s) => ({ phase: s.phase, effort: s.effort, steps: s.steps, errors: s.errors, since: s.t0, until: s.t1 })),
})

// The history with this turn in it (replacing an earlier record of the same turn), newest last.
export const remembered = (history: readonly PastTurn[], turn: PastTurn): PastTurn[] =>
  [...history.filter((t) => t.turnId !== turn.turnId), turn].slice(-HISTORY_TURNS)

// Main over the window (its past turns, then the current one) and the agents that ran in it, the
// newest kept; the advisor calls of the window on main's lane.
const lanesOf = (phases: PhasesState, history: readonly PastTurn[], now: number): Lane[] => {
  const from = now - WINDOW_MS
  const main = phases.loops.find((l) => l.id === 'main')
  const past: Segment[] = history
    .filter((t) => t.turnId !== phases.turnId)
    .flatMap((t) => t.runs)
    .filter((r) => r.until >= from)
    .map((r) => ({ phase: r.phase as Phase, effort: r.effort, t0: r.since, t1: r.until, steps: r.steps, errors: r.errors }))
  const mainSegments = [...past, ...(main === undefined ? [] : segmentsOf(main, now))]
  const agents = phases.loops
    .filter((l) => l.id !== 'main' && l.runs.length > 0 && l.updatedAt >= from)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, mainSegments.length === 0 ? MAX_LANES : MAX_LANES - 1)
    .reverse()
  const agentLanes: Lane[] = agents.map((l) => ({
    id: l.id,
    label: shortType(l.type),
    model: l.model,
    isRunning: l.status === 'running',
    segments: segmentsOf(l, now),
    advisor: [],
  }))
  if (mainSegments.length === 0) return agentLanes
  const mainLane: Lane = {
    id: 'main',
    label: 'main',
    model: main?.model ?? '',
    isRunning: main?.status === 'running',
    segments: mainSegments,
    advisor: phases.advisor.uses.filter((u) => u.at >= from).map((u) => u.at),
  }
  return [mainLane, ...agentLanes]
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

export const sceneOf = (phases: PhasesState | null, insights: InsightsState | null, now: number, history: readonly PastTurn[] = []): Scene => {
  const lanes = phases === null ? [] : lanesOf(phases, history, now)
  const starts = lanes.flatMap((l) => l.segments.map((s) => s.t0))
  const ends = lanes.flatMap((l) => l.segments.map((s) => s.t1))
  return {
    t0: starts.length === 0 ? now : Math.min(...starts),
    t1: ends.length === 0 ? now : Math.max(now, ...ends),
    spans: spansOf(lanes),
    turnId: phases?.turnId ?? null,
    lanes,
    gauges: gaugesOf(phases?.loops.find((l) => l.id === 'main'), insights),
    curves: curvesOf(insights),
  }
}

// Every segment's stretch, merged where the pause between two is under IDLE_MS. O(n log n).
const spansOf = (lanes: readonly Lane[]): Span[] => {
  const all = lanes.flatMap((l) => l.segments.map((s) => ({ t0: s.t0, t1: Math.max(s.t0, s.t1) }))).sort((a, b) => a.t0 - b.t0)
  const out: Span[] = []
  for (const s of all) {
    const last = out[out.length - 1]
    if (last !== undefined && s.t0 - last.t1 < IDLE_MS) last.t1 = Math.max(last.t1, s.t1)
    else out.push({ ...s })
  }
  return out
}

// The axis as laid out: active time in full, each cut pause (between spans, and from the last span
// to now) the same small room. `at` maps an instant; a moment inside a pause sits in its cut.
const axes = new WeakMap<Scene, ReturnType<typeof layAxis>>()
const axisOf = (scene: Scene) => {
  const known = axes.get(scene)
  if (known !== undefined) return known
  const axis = layAxis(scene)
  axes.set(scene, axis)
  return axis
}

const layAxis = (scene: Scene) => {
  const active = scene.spans.reduce((n, s) => n + (s.t1 - s.t0), 0)
  const cut = Math.max(1, active * CUT_SHARE)
  const last = scene.spans[scene.spans.length - 1]
  const trailing = last !== undefined && scene.t1 - last.t1 >= IDLE_MS
  const at = (t: number): number => {
    let offset = 0
    for (const [i, s] of scene.spans.entries()) {
      if (i > 0) offset += cut
      if (t < s.t0) return Math.max(0, offset - cut / 2)
      if (t <= s.t1) return offset + (t - s.t0)
      offset += s.t1 - s.t0
    }
    return offset + (trailing ? Math.min(cut, t - (last?.t1 ?? t)) : 0)
  }
  return { at, total: at(scene.t1), cut, trailing }
}

// A time as a column of a track `width` cells (or pixels) wide.
export const columnOf = (scene: Scene, t: number, width: number): number => {
  const axis = axisOf(scene)
  return axis.total <= 0 ? 0 : Math.min(width - 1, Math.max(0, Math.floor((axis.at(t) / axis.total) * width)))
}

// The columns where a pause was cut, for a dashed mark; and the active time the axis shows.
export const cutsOf = (scene: Scene, width: number): { columns: number[]; activeMs: number } => {
  const axis = axisOf(scene)
  const edges = scene.spans.slice(1).map((s) => s.t0)
  const columns = edges.map((t) => columnOf(scene, t - 1, width))
  if (axis.trailing) columns.push(columnOf(scene, scene.spans[scene.spans.length - 1]!.t1 + 1, width))
  return { columns, activeMs: scene.spans.reduce((n, s) => n + (s.t1 - s.t0), 0) }
}
