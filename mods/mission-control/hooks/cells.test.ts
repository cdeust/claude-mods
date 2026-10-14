import { expect, test } from 'claude-code/testing'

import { paintCells } from './cells'
import { INSIGHTS, PHASES } from './fixture'
import { sceneOf } from './scene'

const scene = sceneOf(PHASES, INSIGHTS, 100_000)

// source: claude-code types, RasterProps: one printable width-1 BMP character per cell (blocks,
// box drawing, braille too), or the whole tree is refused. The painter uses ASCII, the lower
// blocks, the shade and braille; anything else is a defect.
const isAllowed = (c: number) => (c >= 0x20 && c < 0x7f) || (c >= 0x2580 && c <= 0x259f) || (c >= 0x2800 && c <= 0x28ff)

test('every cell is a glyph the Raster accepts, and cells holds exactly columns × rows triplets', () => {
  for (const columns of [40, 80, 143, 200]) {
    const g = paintCells(scene, columns)
    for (let i = 0; i < g.columns * g.rows; i++) expect(isAllowed(g.words[i * 3]!)).toBe(true)
    const decoded = atob(g.encode())
    expect(decoded.length).toBe(g.columns * g.rows * 12)
  }
})

test('the lanes, effort and curves read as drawn', () => {
  const rows = paintCells(scene, 60).glyphRows().map((r) => r.trimEnd())
  expect(rows[0]).toBe('MISSION CONTROL turn turn-000 - 3 lanes')
  // main: analysis at high (▆), implementation at medium (▄), test at medium; the advisor star
  // under analysis, 3 failed calls at the end of test.
  expect(rows[2]).toMatch(/^main {11}▆{12,14}▄+$/)
  expect(rows[3]).toMatch(/^ {15}analysis \*.*implementation.*test.*x3$/)
  expect(rows[5]).toMatch(/analysis +x1$/)
  expect(rows[4]!.startsWith('Explore')).toBe(true)
  expect(rows[6]!.startsWith('code-reviewer')).toBe(true)
  expect(rows.find((r) => r.startsWith('test ')) ).toMatch(/^test {11}█{12}░{4}  high \/ medium$/)
  expect(rows.some((r) => r.startsWith('analysis') && /[⠀-⣿]/.test(r))).toBe(true)
  expect(rows.some((r) => /\^ medium > high/.test(r))).toBe(true)
})

test('an empty session draws its placeholders, not an empty grid', () => {
  const rows = paintCells(sceneOf(null, null, 5), 50).glyphRows().join('\n')
  expect(rows).toMatch(/no step recorded yet this turn/)
  expect(rows).toMatch(/no phase has two points yet/)
})
