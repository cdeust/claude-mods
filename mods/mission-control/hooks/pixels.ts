// The scene's lanes and curves painted as pictures, for terminals that draw pixels. The words
// around them (lane names, phase names, values) stay text, so they are sharp and read by a screen
// reader; the pictures carry what text cannot: bars, marks, lines.

import { Bitmap, CELL_H, CELL_W } from './bitmap'
import { CRITICAL, INK, MUTED, SURFACE, phaseColor } from './palette'
import { type Curve, type Scene, columnOf, rung } from './scene'

const GAP = 2 // source: dataviz skill marks spec, a 2px surface gap between adjacent fills

// One lane per two cell rows: its bar in the upper row, its marks in the lower one, as the cell
// painter lays them, so the lane names beside the picture line up the same way.
export const lanesPicture = (scene: Scene, columns: number): Bitmap => {
  const w = columns * CELL_W
  const bmp = new Bitmap(w, Math.max(1, scene.lanes.length) * 2 * CELL_H, SURFACE)
  scene.lanes.forEach((lane, i) => {
    const base = (i * 2 + 1) * CELL_H // the bar row's bottom edge
    bmp.rect(0, base, w, 1, MUTED)
    for (const s of lane.segments) {
      const x0 = columnOf(scene, s.t0, w)
      const x1 = Math.max(x0 + 2, columnOf(scene, s.t1, w))
      const h = Math.max(2, (rung(s.effort) / 4) * (CELL_H - 2))
      bmp.rect(x0, base - h, x1 - x0 - GAP, h, phaseColor(s.phase))
      if (s.errors > 0) {
        // An x in the critical colour at the end of the run that failed, in the marks row.
        const cx = x1 - GAP - 4
        const cy = base + CELL_H / 2
        bmp.line(cx - 3, cy - 3, cx + 3, cy + 3, CRITICAL)
        bmp.line(cx - 3, cy + 3, cx + 3, cy - 3, CRITICAL)
      }
    }
    for (const at of lane.advisor) {
      // A diamond in the text ink where the advisor was called.
      const cx = columnOf(scene, at, w)
      const cy = base + CELL_H / 2
      for (let d = 0; d <= 4; d++) {
        bmp.rect(cx - (4 - d), cy - d, 2 * (4 - d) + 1, 1, INK)
        bmp.rect(cx - (4 - d), cy + d, 2 * (4 - d) + 1, 1, INK)
      }
    }
  })
  return bmp
}

// One curve over `rows` cell rows: the rate per point, scaled to the curve's own top (at least
// 10 %), a dashed rule where the calibration moved the phase.
export const curvePicture = (c: Curve, columns: number, rows: number): Bitmap => {
  const w = columns * CELL_W
  const h = rows * CELL_H
  const bmp = new Bitmap(w, h, SURFACE)
  const scale = Math.max(0.1, ...c.rates)
  const pad = 3
  const at = (i: number): [number, number] => [
    pad + (i * (w - 2 * pad)) / (c.rates.length - 1),
    h - pad - (c.rates[i]! / scale) * (h - 2 * pad),
  ]
  bmp.rect(0, h - 1, w, 1, MUTED)
  if (c.moveAt !== null) {
    const [x] = at(c.moveAt)
    for (let y = 0; y < h; y += 6) bmp.rect(x, y, 1, 3, INK)
  }
  for (let i = 1; i < c.rates.length; i++) bmp.line(...at(i - 1), ...at(i), phaseColor(c.phase))
  return bmp
}
