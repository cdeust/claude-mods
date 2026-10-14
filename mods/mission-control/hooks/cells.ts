// The scene painted into one grid of cells: lanes, the effort per phase, the learning curves.
// Pure; the register file hands the grid to a `Raster`.

import { Grid, MAX_COLUMNS } from './grid'
import { CRITICAL, GRID, INK, INK_2, MUTED, SURFACE, familyColor, phaseColor } from './palette'
import { FAMILIES, type Curve, type Gauge, type Lane, type ModelFamily, type ModelSteps, type Scene, WINDOW_MS, columnOf, cutsOf, rung } from './scene'

export const LABEL = 15 // source: own choice, the longest phase name ("implementation") is 14, and a space
const RIGHT = 10 // the curves' value column
const CURVE_ROWS = 3 // 12 braille dots tall
const MIN_COLUMNS = 40 // source: own choice, below this the track is too short to read

// Bar height per effort rung: none, low, medium, high, xhigh/max (U+2581..U+2588 lower blocks).
const BARS = [0x2581, 0x2582, 0x2584, 0x2586, 0x2588]
const FULL = 0x2588
const SHADE = 0x2591
const LEVELS = ['low', 'medium', 'high', 'xhigh'] as const

const DASH = 0x250a // ┊, where a pause was cut from the axis

const duration = (ms: number): string => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

const pct = (r: number): string => `${Math.round(r * 100)}%`

const heightOf = (scene: Scene): number =>
  2 + Math.max(1, scene.lanes.length) * 2 + 2 + 2 + Math.max(1, scene.gauges.length) + 1 + 1 + Math.max(1, scene.curves.length * (CURVE_ROWS + 1)) + 3 + scene.models.sessions.length

// The room the printed shares take to the right of a model bar (two spaces, three families).
const SHARES = 24 // source: own choice, "  haiku 12% sonnet 30% opus 58%" is 31 and is cut at the edge

// The bar's columns per family, in the order given, summing to exactly `track`: floor of each
// share, every family with steps at least one column, the difference (the rounding, or the
// columns the minimums took) added to or taken from the widest. A track shorter than the number
// of families gives its columns to the largest ones.
export const segmentWidths = (steps: readonly ModelSteps[], track: number): number[] => {
  const total = steps.reduce((n, s) => n + s.steps, 0)
  const widths = steps.map(() => 0)
  if (total <= 0 || track <= 0) return widths
  const order = steps.map((_, i) => i).filter((i) => steps[i]!.steps > 0).sort((a, b) => steps[b]!.steps - steps[a]!.steps || a - b)
  if (track < order.length) {
    for (const i of order.slice(0, track)) widths[i] = 1
    return widths
  }
  for (const i of order) widths[i] = Math.max(1, Math.floor((steps[i]!.steps / total) * track))
  let diff = track - widths.reduce((n, w) => n + w, 0)
  widths[order[0]!]! += Math.max(0, diff)
  for (; diff < 0; diff++) widths[widths.reduce((best, w, i) => (w > widths[best]! ? i : best), 0)]!--
  return widths
}

export const shareText = (steps: readonly ModelSteps[]): string => {
  const total = steps.reduce((n, s) => n + s.steps, 0)
  return steps.map((s) => `${s.family} ${Math.round((s.steps / total) * 100)}%`).join(' ')
}

// The window's row, then one per session; each with the label it carries, its families in the
// fixed order and only those with a step.
export const modelRows = (scene: Scene): { label: string; steps: ModelSteps[] }[] =>
  [
    { label: 'window', steps: scene.models.window },
    ...scene.models.sessions.map((s) => ({ label: s.session.slice(0, 8), steps: s.steps })),
  ].map((r) => ({ label: r.label, steps: r.steps.filter((s) => s.steps > 0).sort((a, b) => FAMILIES.indexOf(a.family) - FAMILIES.indexOf(b.family)) }))

// The families with a step in any row, in the fixed order.
export const familiesPresent = (scene: Scene): ModelFamily[] => {
  const seen = new Set(modelRows(scene).flatMap((r) => r.steps.map((s) => s.family)))
  return FAMILIES.filter((f) => seen.has(f))
}

function models(g: Grid, scene: Scene, top: number): void {
  g.text(0, top, 'STEPS BY MODEL (this window, then the last sessions)', INK)
  let x = LABEL
  for (const f of familiesPresent(scene)) {
    g.put(x, top + 1, FULL, familyColor(f))
    x = g.text(x + 1, top + 1, ` ${f}  `, INK_2)
  }
  const track = Math.max(1, g.columns - LABEL - SHARES)
  modelRows(scene).forEach((row, i) => {
    const y = top + 2 + i
    g.text(0, y, row.label, INK_2)
    if (row.steps.length === 0) {
      g.text(LABEL, y, 'no step yet', MUTED)
      return
    }
    const widths = segmentWidths(row.steps, track)
    let c = LABEL
    row.steps.forEach((s, k) => {
      for (let w = 0; w < widths[k]!; w++) g.put(c++, y, FULL, familyColor(s.family))
    })
    g.text(LABEL + track, y, `  ${shareText(row.steps)}`, INK_2)
  })
}

function lanes(g: Grid, scene: Scene, top: number): number {
  const width = g.columns - LABEL
  if (scene.lanes.length === 0) {
    g.text(LABEL, top, 'no step recorded yet this turn', MUTED)
    return top + 2
  }
  scene.lanes.forEach((lane: Lane, i) => {
    const y = top + i * 2
    g.text(0, y, lane.label.slice(0, LABEL - 2), lane.isRunning ? INK : INK_2)
    // Failed calls per column, summed: runs closer than a mark's width share one count.
    const fails = new Map<number, number>()
    for (const s of lane.segments) {
      const c0 = columnOf(scene, s.t0, width)
      const c1 = Math.max(c0, columnOf(scene, s.t1, width))
      for (let c = c0; c <= c1; c++) g.put(LABEL + c, y, BARS[rung(s.effort)]!, phaseColor(s.phase))
      if (c1 - c0 > s.phase.length) g.text(LABEL + c0, y + 1, s.phase, INK_2)
      if (s.errors > 0) fails.set(c1, (fails.get(c1) ?? 0) + s.errors)
    }
    for (const at of lane.advisor) g.put(LABEL + columnOf(scene, at, width), y + 1, 0x2a, INK)
    // Each count at its run's end, pulled inside the track first; one that would start within a
    // mark's width (3) and a space of the previous is added to it, so marks never overlap.
    let at = Number.NEGATIVE_INFINITY
    let count = 0
    const flush = () => {
      if (count > 0) g.text(LABEL + at, y + 1, count > 99 ? 'x99' : `x${count}`, CRITICAL)
    }
    for (const c of [...fails.keys()].sort((a, b) => a - b)) {
      const p = Math.min(c, width - 3)
      if (p - at < 4) count += fails.get(c)!
      else {
        flush()
        at = p
        count = fails.get(c)!
      }
    }
    flush()
  })
  // A dashed mark down every lane where a pause was cut, on cells nothing else drew.
  for (const c of cutsOf(scene, width).columns)
    for (let y = top; y < top + scene.lanes.length * 2; y++)
      if (g.words[(y * g.columns + LABEL + c) * 3] === 0x20) g.put(LABEL + c, y, DASH, GRID)
  return top + scene.lanes.length * 2
}

function gauges(g: Grid, list: readonly Gauge[], top: number): number {
  g.text(0, top, 'EFFORT', INK)
  g.text(LABEL, top, 'low med high max  calibrated / last run', MUTED)
  if (list.length === 0) g.text(0, top + 1, 'no phase seen yet', MUTED)
  list.forEach((gauge, i) => {
    const y = top + 1 + i
    const level = rung(gauge.calibrated ?? 'medium')
    g.text(0, y, gauge.phase, INK_2)
    LEVELS.forEach((_, k) => {
      for (let c = 0; c < 4; c++) g.put(LABEL + k * 4 + c, y, k < level ? FULL : SHADE, k < level ? phaseColor(gauge.phase) : GRID)
    })
    g.text(LABEL + 18, y, `${gauge.calibrated ?? 'medium (default)'} / ${gauge.ran ?? '-'}`, gauge.calibrated === null ? MUTED : INK_2)
  })
  return top + 1 + Math.max(1, list.length)
}

function curve(g: Grid, c: Curve, top: number): void {
  const width = g.columns - LABEL - RIGHT
  const dotsX = width * 2
  const dotsY = CURVE_ROWS * 4
  const scale = Math.max(0.1, ...c.rates)
  g.text(0, top, c.phase, INK_2)
  g.text(0, top + 1, `0-${pct(scale)}`, MUTED)
  const at = (i: number): [number, number] => [
    LABEL * 2 + Math.round((i * (dotsX - 1)) / (c.rates.length - 1)),
    top * 4 + dotsY - 1 - Math.round((c.rates[i]! / scale) * (dotsY - 1)),
  ]
  for (let i = 1; i < c.rates.length; i++) g.line(...at(i - 1), ...at(i), phaseColor(c.phase))
  g.text(LABEL + width + 1, top + 1, `${pct(c.rates[0]!)}>${pct(c.rates[c.rates.length - 1]!)}`, INK)
  if (c.moveAt !== null) {
    const x = Math.floor(at(c.moveAt)[0] / 2)
    g.put(x, top + CURVE_ROWS, 0x5e, INK)
    g.text(x + 2, top + CURVE_ROWS, (c.move ?? '').replace('→', '>'), INK_2)
  }
}

export const paintCells = (scene: Scene, columns: number): Grid => {
  const g = new Grid(Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, columns)), heightOf(scene), SURFACE)
  g.text(0, 0, 'MISSION CONTROL', INK)
  g.text(16, 0, `turn ${(scene.turnId ?? '-').slice(0, 8)} - ${scene.lanes.length} lane${scene.lanes.length === 1 ? '' : 's'}, last ${WINDOW_MS / 60_000} min`, MUTED)
  let y = lanes(g, scene, 2)
  const cuts = cutsOf(scene, g.columns - LABEL)
  g.text(LABEL, y, `${duration(cuts.activeMs)} of work${cuts.columns.length === 0 ? '' : `, ${cuts.columns.length} pause${cuts.columns.length === 1 ? '' : 's'} cut`}`, MUTED)
  g.text(g.columns - 3, y, 'now', MUTED)
  y += 2
  y = gauges(g, scene.gauges, y) + 1
  g.text(0, y, 'FAILED CALLS PER STEP, BY PHASE (insights ledger)', INK)
  y += 1
  if (scene.curves.length === 0) g.text(0, y, 'no phase has two points yet: the ledger fills as turns complete', MUTED)
  scene.curves.forEach((c, i) => curve(g, c, y + i * (CURVE_ROWS + 1)))
  models(g, scene, y + Math.max(1, scene.curves.length * (CURVE_ROWS + 1)) + 1)
  return g
}
