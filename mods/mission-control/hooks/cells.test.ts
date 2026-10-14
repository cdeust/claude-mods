import { expect, test } from 'claude-code/testing'

import { paintCells, segmentWidths } from './cells'
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
    models: { window: [], sessions: [] },
    delegations: null,
    mechanical: null,
  }
  const marks = paintCells(crowded, 60).glyphRows()[3]!.trim()
  expect(marks).toBe('test                                    x7')
})

test('a long pause is cut from the axis: two bursts share the track, a dashed mark between them', () => {
  const seg = (t0: number, t1: number) => ({ phase: 'analysis' as const, effort: 'medium', t0, t1, steps: 1, errors: 0 })
  const lanes = [{ id: 'main', label: 'main', model: 'm', isRunning: false, segments: [seg(0, 30_000), seg(630_000, 660_000)], advisor: [] }]
  const bursts = { t0: 0, t1: 660_000, spans: [{ t0: 0, t1: 30_000 }, { t0: 630_000, t1: 660_000 }], turnId: 't', lanes, gauges: [], curves: [], models: { window: [], sessions: [] }, delegations: null, mechanical: null }
  const rows = paintCells(bursts, 15 + 100).glyphRows()
  const bar = rows[2]!.slice(15)
  const cut = bar.indexOf('┊') >= 0 ? bar.indexOf('┊') : rows[3]!.slice(15).indexOf('┊')
  // 60 s of work over 100 columns, the cut taking 4 % of it: each burst ~48 columns, not 5.
  expect(bar.split('').filter((c) => c === '▄').length).toBeGreaterThan(90)
  expect(cut).toBeGreaterThan(40)
  expect(cut).toBeLessThan(60)
  expect(rows[4]).toMatch(/1m00s of work, 1 pause cut/)
})

test('segmentWidths always sums to the track, every family with steps getting a column when the track allows', () => {
  const widths = (steps: number[], track: number) => segmentWidths(steps.map((n, i) => ({ family: (['haiku', 'sonnet', 'opus'] as const)[i % 3]!, steps: n })), track)
  expect(widths([1000], 20)).toEqual([20])
  expect(widths([1000], 1)).toEqual([1])
  expect(widths([1, 1, 1], 20)).toEqual([8, 6, 6])
  expect(widths([1, 1, 1], 1)).toEqual([1, 0, 0])
  expect(widths([1, 1, 1], 3)).toEqual([1, 1, 1])
  expect(widths([1, 1000], 21)).toEqual([1, 20])
  expect(widths([1, 1, 1, 1, 1000], 5)).toEqual([1, 1, 1, 1, 1].map((w, i) => (i === 4 ? 1 : w)))
  expect(widths([0, 0], 10)).toEqual([0, 0])
  for (let track = 1; track <= 40; track++)
    for (const steps of [[1, 2, 3], [7, 7, 7], [1, 1, 1000], [5, 0, 5], [999, 1, 1]])
      expect(widths(steps, track).reduce((a, b) => a + b, 0)).toBe(track)
})

test('STEPS BY MODEL: a header, a legend, the window then one row per session', () => {
  const rows = paintCells(scene, 60).glyphRows().map((r) => r.trimEnd())
  const at = rows.findIndex((r) => r.startsWith('STEPS BY MODEL'))
  const section = rows.slice(at, at + 5)
  expect(section).toEqual([
    'STEPS BY MODEL (this window, then the last sessions)',
    '               █ haiku  █ sonnet  █ opus',
    'window         █████████████████████  haiku 15% opus 85%',
    'abc10001       █████████████████████  sonnet 30% opus 70%',
    'def20002       █████████████████████  haiku 12% sonnet 30% o',
  ])
})

test('a row with no step prints no step yet', () => {
  const rows = paintCells(sceneOf(null, null, 5), 50).glyphRows().map((r) => r.trimEnd())
  expect(rows.find((r) => r.startsWith('window'))).toBe('window         no step yet')
})

test('DELEGATIONS: the header, the counts with their names, the newest rows first, the heavy share', () => {
  const rows = paintCells(scene, 70).glyphRows().map((r) => r.trimEnd())
  const at = rows.findIndex((r) => r.startsWith('DELEGATIONS'))
  expect(rows.slice(at)).toEqual([
    'DELEGATIONS (judged against their DESIGN block)',
    '9 delegations, 7 designed',
    'overkill 2  underpowered 0  undesigned 1  rerouted 0',
    'zetetic-team-s haiku - 4st 0x  undesigned',
    'Explore        opus high 12st 1x  overkill',
    'main on opus/fable: 25% reading (analysis) over 5 sessions',
  ])
})

test('DELEGATIONS: at 60 columns every flag name is still in the glyph rows', () => {
  const text = paintCells(scene, 60).glyphRows().join('\n')
  for (const f of ['overkill', 'underpowered', 'undesigned', 'rerouted']) expect(text).toContain(f)
})

test('an insights state with neither delegations nor mechanical (0.3.0) draws a placeholder and no crash', () => {
  const { delegations: _d, mechanical: _m, ...old } = INSIGHTS as unknown as Record<string, unknown>
  const s = sceneOf(PHASES, old as unknown as typeof INSIGHTS, 100_000)
  expect(s.delegations).toBeNull()
  expect(s.mechanical).toBeNull()
  const rows = paintCells(s, 70).glyphRows().map((r) => r.trimEnd())
  expect(rows.slice(rows.findIndex((r) => r.startsWith('DELEGATIONS'))).filter((r) => r !== '')).toEqual([
    'DELEGATIONS (judged against their DESIGN block)',
    'no delegation judged yet',
  ])
})

test('a null share says no heavy step yet; a non-zero count is the only CRITICAL one', () => {
  const s = sceneOf(PHASES, { ...INSIGHTS, mechanical: { sessions: 0, heavyAnalysis: 0, heavySteps: 0, share: null } }, 100_000)
  expect(paintCells(s, 70).glyphRows().some((r) => r.startsWith('main on opus/fable: no heavy step yet'))).toBe(true)
})
