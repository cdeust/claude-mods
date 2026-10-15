// What the pane shows, as data both painters draw: the turn's lanes (main and its agents) over
// time, the effort each phase runs at, and each phase's learning curve. Pure: the same state at
// the same instant is the same scene.

import type { PluginState } from 'claude-code'

import type { PastTurn } from '../types'

export type PhasesState = PluginState['zetetic-autopilot']['phases']
export type InsightsState = PluginState['zetetic-insights']['insights']
type LoopPhases = PhasesState['loops'][number]
// Structural copies of the insights contract's types (a mod cannot import another mod's file).
export type ModelFamily = 'haiku' | 'sonnet' | 'opus' | 'fable' | 'other' | 'unknown'
export type ModelSteps = { family: ModelFamily; steps: number }
export type SessionModels = InsightsState['models'][number]
export type Phase = NonNullable<LoopPhases['phase']>

export const MAX_LANES = 8 // source: own choice, main and the seven agents seen last
export const WINDOW_MS = 10 * 60_000 // source: own choice, the recent past the lanes span
export const HISTORY_TURNS = 20 // source: own choice, main's past turns kept for the window
export const MODEL_ROWS = 8 // source: own choice, the last sessions drawn beside the window
export const PROBE_STEPS = 1 // source: audit 2026-10-15 (insights-audit/report.md section 1): 20 of 24 ledger sessions were `claude -p` probe runs of one step. The insights state carries no cwd per session, so a session of at most this many steps in total stands for a probe
export const IDLE_MS = 20_000 // source: own choice, a pause this long is cut from the time axis
const CUT_SHARE = 0.04 // source: own choice, the room one cut takes, as a share of the active time
export const FAMILIES: readonly ModelFamily[] = ['haiku', 'sonnet', 'opus', 'fable', 'other', 'unknown'] // cheap to dear, then the rest
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
export type Delegations = InsightsState['delegations']
export type Mechanical = InsightsState['mechanical']
export type Frictions = InsightsState['frictions']
// `probes`: how many of the insights' sessions were left out of `sessions` as probes.
export type Models = { window: ModelSteps[]; sessions: SessionModels[]; probes: number }
export type Scene = { t0: number; t1: number; spans: Span[]; turnId: string | null; lanes: Lane[]; gauges: Gauge[]; curves: Curve[]; models: Models; delegations: Delegations | null; mechanical: Mechanical | null; frictions: Frictions | null }

// A model id as its family: the first of fable, opus, sonnet, haiku found in it, else other.
export const familyOf = (model: unknown): ModelFamily => {
  if (typeof model !== 'string' || model === '') return 'unknown'
  const m = model.toLowerCase()
  return (['fable', 'opus', 'sonnet', 'haiku'] as const).find((f) => m.includes(f)) ?? 'other'
}

// Steps added per family, in FAMILIES order, a family with no step left out.
const tally = (parts: readonly { model: string; steps: number }[]): ModelSteps[] => {
  const by = new Map<ModelFamily, number>()
  for (const p of parts) by.set(familyOf(p.model), (by.get(familyOf(p.model)) ?? 0) + p.steps)
  return FAMILIES.filter((f) => (by.get(f) ?? 0) > 0).map((family) => ({ family, steps: by.get(family)! }))
}

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
  model: main.model,
  runs: segmentsOf(main, now).map((s) => ({ phase: s.phase, effort: s.effort, steps: s.steps, errors: s.errors, since: s.t0, until: s.t1 })),
})

// The history with this turn in it (replacing an earlier record of the same turn), newest last.
export const remembered = (history: readonly PastTurn[], turn: PastTurn): PastTurn[] =>
  [...history.filter((t) => t.turnId !== turn.turnId), turn].slice(-HISTORY_TURNS)

// The one rule for every flow (main's past turns, main's live turn, each agent): a run is in the
// window when it ends at or after the window's start. A run's end is its segment's t1: now while
// its loop runs, else the loop's last step. A main turn that ended before the window is left out,
// lane and count alike.
const inWindow = (from: number) => (s: Segment): boolean => s.t1 >= from

// Main over the window (its past turns, then the current one) and the agents that ran in it, the
// newest kept; the advisor calls of the window on main's lane.
const lanesOf = (phases: PhasesState, history: readonly PastTurn[], now: number): { lanes: Lane[]; window: ModelSteps[] } => {
  const from = now - WINDOW_MS
  const counted = inWindow(from)
  const main = phases.loops.find((l) => l.id === 'main')
  const pastRuns = history
    .filter((t) => t.turnId !== phases.turnId)
    .flatMap((t) => t.runs.map((r) => ({ model: t.model, seg: { phase: r.phase as Phase, effort: r.effort, t0: r.since, t1: r.until, steps: r.steps, errors: r.errors } as Segment })))
    .filter(({ seg }) => counted(seg))
  const mainLive = (main === undefined ? [] : segmentsOf(main, now)).filter(counted)
  const mainSegments = [...pastRuns.map(({ seg }) => seg), ...mainLive]
  const agents = phases.loops
    .filter((l) => l.id !== 'main' && l.runs.length > 0 && l.updatedAt >= from)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, mainSegments.length === 0 ? MAX_LANES : MAX_LANES - 1)
    .reverse()
    .map((l) => ({ loop: l, segments: segmentsOf(l, now).filter(counted) }))
  const agentLanes: Lane[] = agents.map(({ loop: l, segments }) => ({
    id: l.id,
    label: shortType(l.type),
    model: l.model,
    isRunning: l.status === 'running',
    segments,
    advisor: [],
  }))
  // The window's steps by model, counted by the one rule: main's past runs under their turn's model,
  // its current runs under main's, each shown agent under its own.
  const window = tally([
    ...pastRuns.map(({ model, seg }) => ({ model, steps: seg.steps })),
    ...mainLive.map((s) => ({ model: main?.model ?? '', steps: s.steps })),
    ...agents.flatMap(({ loop: l, segments }) => segments.map((s) => ({ model: l.model, steps: s.steps }))),
  ])
  if (mainSegments.length === 0) return { lanes: agentLanes, window }
  const mainLane: Lane = {
    id: 'main',
    label: 'main',
    model: main?.model ?? '',
    isRunning: main?.status === 'running',
    segments: mainSegments,
    advisor: phases.advisor.uses.filter((u) => u.at >= from).map((u) => u.at),
  }
  return { lanes: [mainLane, ...agentLanes], window }
}

// A session is a probe when all its steps together are at most PROBE_STEPS.
const isProbe = (s: SessionModels): boolean => s.steps.reduce((n, f) => n + f.steps, 0) <= PROBE_STEPS

// The probes are counted apart and the last MODEL_ROWS real sessions kept: filtering first, so probes never take a row.
const modelsOf = (window: ModelSteps[], insights: InsightsState | null): Models => {
  const all = insights?.models ?? []
  return { window, sessions: all.filter((s) => !isProbe(s)).slice(-MODEL_ROWS), probes: all.filter(isProbe).length }
}

// The one scale every learning curve is drawn on: the highest rate of any curve, so a curve's height
// compares with the others'. 10 % when no curve ever failed (nothing to scale, and no division by zero).
export const curveScale = (curves: readonly Curve[]): number => {
  const top = curves.reduce((m, c) => Math.max(m, ...c.rates), 0)
  return top > 0 ? top : 0.1
}

// What a curve's label says: the latest rate, the highest, and over how many points. Never first against last.
export const curveSummary = (c: Curve): { last: number; peak: number; n: number } => ({ last: c.rates[c.rates.length - 1]!, peak: Math.max(...c.rates), n: c.rates.length })

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

// State survives a plugin reload, so a turn written by an earlier version may have no model: read as
// '' (unknown), the same as the insights side's `mainModel ?? ''`.
const settled = (history: readonly PastTurn[]): PastTurn[] =>
  history.map((t) => ({ ...t, model: typeof t.model === 'string' ? t.model : '' }))

export const sceneOf = (phases: PhasesState | null, insights: InsightsState | null, now: number, history: readonly PastTurn[] = []): Scene => {
  const { lanes, window } = phases === null ? { lanes: [], window: [] } : lanesOf(phases, settled(history), now)
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
    models: modelsOf(window, insights),
    // An older insights (0.3.0 has no delegations, 0.4.0 no mechanical) sends neither: null, never a crash.
    delegations: insights?.delegations ?? null,
    mechanical: insights?.mechanical ?? null,
    // An older insights (before 0.7.0) has no frictions: null draws no section, never a crash.
    frictions: insights?.frictions ?? null,
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
