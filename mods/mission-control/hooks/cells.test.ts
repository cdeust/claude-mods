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
  expect(rows[0]).toBe('MISSION CONTROL turn turn-000 - 3 lanes, last 10 min')
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

test('failed calls of runs closer than a mark are summed into one count, never printed over each other', () => {
  const seg = (t0: number, t1: number, errors: number) => ({ phase: 'test' as const, effort: 'low', t0, t1, steps: 2, errors })
  const crowded = {
    t0: 0,
    t1: 1000,
    spans: [{ t0: 0, t1: 1000 }],
    turnId: 't',
    lanes: [{ id: 'main', label: 'main', model: 'm', isRunning: false, segments: [seg(0, 900, 1), seg(900, 910, 4), seg(950, 1000, 2)], advisor: [] }],
    gauges: [],
    curves: [],
  }
  const marks = paintCells(crowded, 60).glyphRows()[3]!.trim()
  expect(marks).toBe('test                                    x7')
})

test('a long pause is cut from the axis: two bursts share the track, a dashed mark between them', () => {
  const seg = (t0: number, t1: number) => ({ phase: 'analysis' as const, effort: 'medium', t0, t1, steps: 1, errors: 0 })
  const lanes = [{ id: 'main', label: 'main', model: 'm', isRunning: false, segments: [seg(0, 30_000), seg(630_000, 660_000)], advisor: [] }]
  const bursts = { t0: 0, t1: 660_000, spans: [{ t0: 0, t1: 30_000 }, { t0: 630_000, t1: 660_000 }], turnId: 't', lanes, gauges: [], curves: [] }
  const rows = paintCells(bursts, 15 + 100).glyphRows()
  const bar = rows[2]!.slice(15)
  const cut = bar.indexOf('┊') >= 0 ? bar.indexOf('┊') : rows[3]!.slice(15).indexOf('┊')
  // 60 s of work over 100 columns, the cut taking 4 % of it: each burst ~48 columns, not 5.
  expect(bar.split('').filter((c) => c === '▄').length).toBeGreaterThan(90)
  expect(cut).toBeGreaterThan(40)
  expect(cut).toBeLessThan(60)
  expect(rows[4]).toMatch(/1m00s of work, 1 pause cut/)
})
