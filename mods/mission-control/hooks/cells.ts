// The scene painted into one grid of cells: lanes, the effort per phase, the learning curves.
// Pure; the register file hands the grid to a `Raster`.

import { Grid, MAX_COLUMNS } from './grid'
import { CRITICAL, INK, INK_2, MUTED, SURFACE, phaseColor } from './palette'
import { type Curve, type Gauge, type Lane, type Scene, columnOf, rung } from './scene'

export const LABEL = 15 // source: own choice, the longest phase name ("implementation") is 14, and a space
const RIGHT = 10 // the curves' value column
const CURVE_ROWS = 3 // 12 braille dots tall
const MIN_COLUMNS = 40 // source: own choice, below this the track is too short to read

// Bar height per effort rung: none, low, medium, high, xhigh/max (U+2581..U+2588 lower blocks).
const BARS = [0x2581, 0x2582, 0x2584, 0x2586, 0x2588]
const FULL = 0x2588
const SHADE = 0x2591
const LEVELS = ['low', 'medium', 'high', 'xhigh'] as const

const ago = (ms: number): string => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `-${s}s` : `-${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

const pct = (r: number): string => `${Math.round(r * 100)}%`

const heightOf = (scene: Scene): number =>
  2 + Math.max(1, scene.lanes.length) * 2 + 2 + 2 + Math.max(1, scene.gauges.length) + 1 + 1 + Math.max(1, scene.curves.length * (CURVE_ROWS + 1))

function lanes(g: Grid, scene: Scene, top: number): number {
  const width = g.columns - LABEL
  if (scene.lanes.length === 0) {
    g.text(LABEL, top, 'no step recorded yet this turn', MUTED)
    return top + 2
  }
  scene.lanes.forEach((lane: Lane, i) => {
    const y = top + i * 2
    g.text(0, y, lane.label.slice(0, LABEL - 2), lane.isRunning ? INK : INK_2)
    for (const s of lane.segments) {
      const c0 = columnOf(scene, s.t0, width)
      const c1 = Math.max(c0, columnOf(scene, s.t1, width))
      for (let c = c0; c <= c1; c++) g.put(LABEL + c, y, BARS[rung(s.effort)]!, phaseColor(s.phase))
      if (c1 - c0 > s.phase.length) g.text(LABEL + c0, y + 1, s.phase, INK_2)
      // At the run's end, pulled left so its count stays inside the track.
      if (s.errors > 0) g.text(LABEL + Math.min(c1, width - 2), y + 1, s.errors > 9 ? 'x+' : `x${s.errors}`, CRITICAL)
    }
    for (const at of lane.advisor) g.put(LABEL + columnOf(scene, at, width), y + 1, 0x2a, INK)
  })
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
      for (let c = 0; c < 4; c++) g.put(LABEL + k * 4 + c, y, k < level ? FULL : SHADE, k < level ? phaseColor(gauge.phase) : MUTED)
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
  g.text(16, 0, `turn ${(scene.turnId ?? '-').slice(0, 8)} - ${scene.lanes.length} lanes`, MUTED)
  let y = lanes(g, scene, 2)
  g.text(LABEL, y, ago(scene.t1 - scene.t0), MUTED)
  g.text(g.columns - 3, y, 'now', MUTED)
  y += 2
  y = gauges(g, scene.gauges, y) + 1
  g.text(0, y, 'FAILED CALLS PER TURN, BY PHASE (insights ledger)', INK)
  y += 1
  if (scene.curves.length === 0) g.text(0, y, 'no phase has two points yet: the ledger fills as turns complete', MUTED)
  scene.curves.forEach((c, i) => curve(g, c, y + i * (CURVE_ROWS + 1)))
  return g
}
