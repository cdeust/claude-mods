import { expect, test } from 'claude-code/testing'

import { paintCells } from './cells'
import { INSIGHTS, PHASES } from './fixture'
import { type Curve, sceneOf, stepLane } from './scene'

const scene = sceneOf(PHASES, INSIGHTS, 100_000)

// source: claude-code types, RasterProps: one printable width-1 BMP character per cell (blocks,
// box drawing, braille too), or the whole tree is refused. The painter uses ASCII, box drawing
// (the bands' rules, the cut mark), the blocks, the shade and braille; anything else is a defect.
const isAllowed = (c: number) => (c >= 0x20 && c < 0x7f) || (c >= 0x2500 && c <= 0x259f) || (c >= 0x2800 && c <= 0x28ff)

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
  expect(rows[2]).toMatch(/^── FOR YOU  what ran, and how it went ─+$/)
  expect(rows[4]).toMatch(/^main {11}▆{12,14}▄+$/)
  expect(rows[5]).toMatch(/^ {15}analysis \*.*implementation.*test.*x3$/)
  expect(rows[7]).toMatch(/analysis +x1$/)
  expect(rows[6]!.startsWith('Explore')).toBe(true)
  expect(rows[8]!.startsWith('code-reviewer')).toBe(true)
  expect(rows[10]).toMatch(/^model {10}▇+$/)
  expect(rows.find((r) => /^test {11}[█░]/.test(r))).toMatch(/^test {11}█{12}░{4}  high \/ medium$/)
  // analysis peaks at 10% on the shared 0-40% scale: its dots are in the three rows from its name down.
  const at = rows.findIndex((r) => r.startsWith('analysis') && /last/.test(r))
  expect(rows.slice(at, at + 3).some((r) => /[⠁-⣿]/.test(r))).toBe(true)
  expect(rows.some((r) => /\^ medium > high/.test(r))).toBe(true)
})

test('an empty session draws its placeholders, not an empty grid', () => {
  const rows = paintCells(sceneOf(null, null, 5), 50).glyphRows().join('\n')
  expect(rows).toMatch(/idle: no agent in the last 10 min/)
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
    models: { window: [], sessions: [], probes: 0 },
    delegations: null,
    mechanical: null,
    frictions: null,
  }
  const marks = paintCells(crowded, 60).glyphRows()[5]!.trim()
  expect(marks).toBe('test                                    x7')
})

test('a long pause is cut from the axis: two bursts share the track, a dashed mark between them', () => {
  const seg = (t0: number, t1: number) => ({ phase: 'analysis' as const, effort: 'medium', t0, t1, steps: 1, errors: 0 })
  const lanes = [{ id: 'main', label: 'main', model: 'm', isRunning: false, segments: [seg(0, 30_000), seg(630_000, 660_000)], advisor: [] }]
  const bursts = { t0: 0, t1: 660_000, spans: [{ t0: 0, t1: 30_000 }, { t0: 630_000, t1: 660_000 }], turnId: 't', lanes, gauges: [], curves: [], models: { window: [], sessions: [], probes: 0 }, delegations: null, mechanical: null, frictions: null }
  const rows = paintCells(bursts, 15 + 100).glyphRows()
  const bar = rows[4]!.slice(15)
  const cut = bar.indexOf('┊') >= 0 ? bar.indexOf('┊') : rows[5]!.slice(15).indexOf('┊')
  // 60 s of work over 100 columns, the cut taking 4 % of it: each burst ~48 columns, not 5.
  expect(bar.split('').filter((c) => c === '▄').length).toBeGreaterThan(90)
  expect(cut).toBeGreaterThan(40)
  expect(cut).toBeLessThan(60)
  expect(rows[7]).toMatch(/1m00s of work, 1 pause cut/)
})

test('DELEGATIONS: the header, the counts with their names, the newest rows first, the heavy share', () => {
  const rows = paintCells(scene, 70).glyphRows().map((r) => r.trimEnd())
  const at = rows.findIndex((r) => r.startsWith('DELEGATIONS'))
  expect(rows.slice(at, at + 6)).toEqual([
    'DELEGATIONS (judged against their DESIGN block)',
    '9 delegations, 7 designed',
    'overkill 2  underpowered 0  undesigned 1  rerouted 0',
    'zetetic-team-s haiku - 4st 0x  undesigned',
    'Explore        opus high 12st 1x  overkill',
    'main opus/fable: 25% steps only Read/Grep/Glob, 5 sessions',
  ])
})

test('DELEGATIONS: at 60 columns every flag name is still in the glyph rows', () => {
  const text = paintCells(scene, 60).glyphRows().join('\n')
  for (const f of ['overkill', 'underpowered', 'undesigned', 'rerouted']) expect(text).toContain(f)
})

test('an insights state with neither delegations nor mechanical (0.3.0) draws a placeholder and no crash', () => {
  const { delegations: _d, mechanical: _m, frictions: _f, ...old } = INSIGHTS as unknown as Record<string, unknown>
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
  const s = sceneOf(PHASES, { ...INSIGHTS, mechanical: { sessions: 0, heavyReads: 0, heavySteps: 0, unmeasured: 0, share: null } }, 100_000)
  expect(paintCells(s, 70).glyphRows().some((r) => r.startsWith('main opus/fable: no measured step yet'))).toBe(true)
})

test('a mechanical share from an insights without the new fields still draws its line', () => {
  const old = { sessions: 3, heavyAnalysis: 3, heavySteps: 12, share: 0.25 } as unknown as NonNullable<typeof INSIGHTS['mechanical']>
  const s = sceneOf(PHASES, { ...INSIGHTS, mechanical: old }, 100_000)
  expect(paintCells(s, 70).glyphRows().some((r) => r.startsWith('main opus/fable: 25% steps only Read/Grep/Glob, 3 sessions'))).toBe(true)
})

test('DELEGATIONS: at 60 columns the whole share line is present', () => {
  expect(paintCells(scene, 60).glyphRows().map((r) => r.trimEnd())).toContain('main opus/fable: 25% steps only Read/Grep/Glob, 5 sessions')
})

test('FRICTIONS: after DELEGATIONS, one row per recurring friction, kind in 15 columns then sessions, times and the signature', () => {
  const rows = paintCells(scene, 70).glyphRows().map((r) => r.trimEnd())
  const at = rows.findIndex((r) => r.startsWith('FRICTIONS'))
  expect(at).toBeGreaterThan(rows.findIndex((r) => r.startsWith('DELEGATIONS')))
  expect(rows[at - 1]).toBe('') // a blank row between the sections
  expect(rows.slice(at)).toEqual([
    'FRICTIONS (recurring over the last sessions)',
    'hook-block      4s 16x Owned cleanup remains: [{<Q>: <Q>}]',
    'harness-refusal 3s 5x Permission to use Bash with command rm -rf <PATH',
    'hook-error      2s 17x Failed to run: Plugin directory does not exist:',
  ])
})

test('FRICTIONS: at most 5 rows, each cut to the pane width', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ kind: 'hook-block' as const, signature: `row ${i} ${'x'.repeat(100)}`, sessions: 9 - i, count: 1 }))
  const s = sceneOf(PHASES, { ...INSIGHTS, frictions: many }, 100_000)
  for (const columns of [40, 60, 90]) {
    const rows = paintCells(s, columns).glyphRows().map((r) => r.trimEnd())
    const at = rows.findIndex((r) => r.startsWith('FRICTIONS'))
    expect(rows.slice(at + 1).filter((r) => r !== '')).toHaveLength(5)
    expect(rows.slice(at + 1)[4]!.startsWith('hook-block      5s 1x row 4 ')).toBe(true)
    expect(Math.max(...rows.map((r) => r.length))).toBeLessThanOrEqual(columns)
  }
})

test('FRICTIONS: an insights without the field (before 0.7.0) draws no section and no crash; an empty list draws its placeholder', () => {
  const { frictions: _f, ...old } = INSIGHTS as unknown as Record<string, unknown>
  const s = sceneOf(PHASES, old as unknown as typeof INSIGHTS, 100_000)
  expect(s.frictions).toBeNull()
  const rows = paintCells(s, 70).glyphRows().map((r) => r.trimEnd())
  expect(rows.some((r) => r.includes('FRICTION'))).toBe(false)
  expect(rows[rows.length - 1]).toBe('main opus/fable: 25% steps only Read/Grep/Glob, 5 sessions')
  expect(sceneOf(null, null, 5).frictions).toBeNull()
  const none = paintCells(sceneOf(PHASES, { ...INSIGHTS, frictions: [] }, 100_000), 70).glyphRows().map((r) => r.trimEnd())
  expect(none.slice(none.findIndex((r) => r.startsWith('FRICTIONS')))).toEqual(['FRICTIONS (recurring over the last sessions)', 'no friction recurs over 2 sessions yet'])
})

test('FRICTIONS: a signature with a glyph the Raster refuses is drawn as ?, so the grid stays inside the allowlist', () => {
  const odd = [{ kind: 'hook-error' as const, signature: 'Plugin \u2014 run /plugin \u00e9\u{1F600}', sessions: 2, count: 2 }]
  const g = paintCells(sceneOf(PHASES, { ...INSIGHTS, frictions: odd }, 100_000), 80)
  for (let i = 0; i < g.columns * g.rows; i++) expect(isAllowed(g.words[i * 3]!)).toBe(true)
  expect(g.glyphRows().some((r) => r.includes('Plugin ? run /plugin ??'))).toBe(true)
})

const curveOf = (phase: Curve['phase'], rates: number[]): Curve => ({ phase, rates, moveAt: null, move: null })
const withCurves = (curves: Curve[]) => ({ ...sceneOf(null, null, 5), curves })

test('a curve that peaks mid-way is labelled by its latest rate and its peak, never by an empty-looking first>last delta', () => {
  const rows = paintCells(withCurves([curveOf('report', [0, 0, 1, 0, 0])]), 80).glyphRows().join('\n')
  expect(rows).not.toMatch(/0%>0%/)
  expect(rows).toMatch(/last 0%/)
  expect(rows).toMatch(/peak 100%/)
  expect(rows).toMatch(/n=5/)
})

test('every curve is drawn on one scale, printed once: a quiet phase reads flat, not 0-10%', () => {
  const both = paintCells(withCurves([curveOf('analysis', [0, 0.05, 0.02]), curveOf('report', [0, 1, 0])]), 80)
  const rows = both.glyphRows()
  expect(rows.join('\n')).toMatch(/one scale, 0-100%/)
  expect(rows.join('\n')).not.toMatch(/\b0-5%|\b0-10%/)
  // Alone the quiet curve fills its box (its own top); beside a 100% curve its 5% peak is drawn in the
  // bottom dot row only: the first of its three cell rows holds no dot.
  const first = rows.findIndex((r) => r.startsWith('analysis'))
  expect(/[⠀-⣿]/.test(rows[first]!.slice(15, 70).replace(/ /g, ''))).toBe(false)
  // the quiet phase still says its own peak, on the row under its name
  expect(rows[first + 1]!.slice(0, 15)).toMatch(/^peak 5%/)
  expect(rows[first + 1]!.slice(0, 15)).not.toMatch(/100%/)
  const alone = paintCells(withCurves([curveOf('analysis', [0, 0.05, 0.02])]), 80).glyphRows()
  expect(/[⠁-⣿]/.test(alone[alone.findIndex((r) => r.startsWith('analysis'))]!.slice(15, 70))).toBe(true)
})

test('sessions of one step are probes: counted apart, not drawn as 100% rows', () => {
  const probe = (session: string) => ({ session, at: 1, steps: [{ family: 'haiku' as const, steps: 1 }] })
  const real = { session: 'real0001-x', at: 2, steps: [{ family: 'sonnet' as const, steps: 20 }, { family: 'opus' as const, steps: 4 }] }
  const insights = { ...INSIGHTS, models: [probe('p1'), probe('p2'), probe('p3'), real] } as unknown as typeof INSIGHTS
  const s = sceneOf(null, insights, 5)
  expect(s.models.sessions.map((x) => x.session)).toEqual(['real0001-x'])
  expect(s.models.probes).toBe(3)
  const rows = paintCells(s, 100).glyphRows().join('\n')
  expect(rows).toMatch(/\+3 probe sessions hidden/)
  expect(rows).toMatch(/SHARE OF STEPS \(the 1 session above, 24 steps\)/)
  expect(rows).toMatch(/sonnet +█+░* +83% +20/)
  expect(rows).toMatch(/opus +█+░* +17% +4/)
  expect(rows).not.toMatch(/haiku +█/)
})

test('no lane in the window says idle, in the header and the lanes area', () => {
  const rows = paintCells(sceneOf(null, null, 5), 80).glyphRows()
  expect(rows[0]).toMatch(/idle, last 10 min/)
  expect(rows[4]).toMatch(/idle: no agent in the last 10 min/)
})

test('stepLane: each column shows the dearest family among its steps, the oldest step left', () => {
  // 4 steps over 2 columns: (haiku, opus) then (sonnet, haiku).
  expect(stepLane([{ family: 'haiku', steps: 1 }, { family: 'opus', steps: 1 }, { family: 'sonnet', steps: 1 }, { family: 'haiku', steps: 1 }], 2)).toEqual(['opus', 'sonnet'])
  // Fewer steps than columns: each step spans its columns.
  expect(stepLane([{ family: 'haiku', steps: 1 }, { family: 'opus', steps: 1 }], 4)).toEqual(['haiku', 'haiku', 'opus', 'opus'])
  // other and unknown never hide a named family; alone they are drawn.
  expect(stepLane([{ family: 'unknown', steps: 1 }, { family: 'haiku', steps: 1 }], 1)).toEqual(['haiku'])
  expect(stepLane([{ family: 'other', steps: 2 }], 2)).toEqual(['other', 'other'])
  expect(stepLane([], 3)).toEqual([null, null, null])
  // fable is the dearest.
  expect(stepLane([{ family: 'opus', steps: 3 }, { family: 'fable', steps: 1 }], 1)).toEqual(['fable'])
})

test('MODEL PER STEP: one lane per session in step order, its step count after it, a legend above', () => {
  const g = paintCells(scene, 60)
  const rows = g.glyphRows().map((r) => r.trimEnd())
  const at = rows.findIndex((r) => r.startsWith('MODEL PER STEP'))
  expect(rows[at + 1]).toBe('               ▃ haiku   ▅ sonnet   ▇ opus')
  expect(rows[at + 2]).toMatch(/^abc10001 {7}▇{14}▅{10}▇{11} 100 st$/)
  expect(rows[at + 3]).toMatch(/^def20002 {7}▇{7}▃{4}▅{11}▇{13} 100 st$/)
  // Colour and height follow the order: def20002 starts on opus, has haiku a fifth in, ends on opus.
  const fg = (x: number, y: number) => g.words[(y * g.columns + x) * 3 + 1]!
  expect(fg(15, at + 3)).toBe(0xaf005f)
  expect(fg(15 + 8, at + 3)).toBe(0x00af5f)
  expect(fg(15 + 34, at + 3)).toBe(0xaf005f)
})

test('MODEL PER STEP: an insights that sends no step order says so instead of inventing one', () => {
  const old = { ...INSIGHTS, models: INSIGHTS.models.map((m) => ({ ...m, sequence: undefined })) } as unknown as typeof INSIGHTS
  const rows = paintCells(sceneOf(PHASES, old, 100_000), 90).glyphRows().map((r) => r.trimEnd())
  expect(rows).toContain('abc10001       step order not sent (zetetic-insights before 0.10)')
})

test('SHARE OF STEPS: one row per family, the share and the count printed in full at every width', () => {
  for (const columns of [40, 60, 100]) {
    const rows = paintCells(scene, columns).glyphRows().map((r) => r.trimEnd())
    const at = rows.findIndex((r) => r.startsWith('SHARE OF STEPS'))
    expect(rows[at]).toBe('SHARE OF STEPS (the 2 sessions above, 200 steps)'.slice(0, columns))
    expect(rows[at + 1]).toMatch(/^haiku {10}█+░+ +6% {2}12$/)
    expect(rows[at + 2]).toMatch(/^sonnet {9}█+░+ +30% {2}60$/)
    expect(rows[at + 3]).toMatch(/^opus {11}█+░+ +64% {2}128$/)
    for (const r of rows.slice(at + 1, at + 4)) expect(r.length).toBeLessThanOrEqual(columns)
  }
})

test('two bands: FOR YOU above, FOR CLAUDE below holding the brief as sent, the effort and the live evidence', () => {
  const rows = paintCells(scene, 100).glyphRows().map((r) => r.trimEnd())
  const you = rows.findIndex((r) => r.startsWith('── FOR YOU'))
  const claude = rows.findIndex((r) => r.startsWith('── FOR CLAUDE'))
  expect(you).toBe(2)
  for (const s of ['MODEL PER STEP', 'SHARE OF STEPS', 'FAILED CALLS']) {
    const at = rows.findIndex((r) => r.startsWith(s))
    expect(at > you && at < claude).toBe(true)
  }
  for (const s of ['SELF-CALIBRATION BRIEF', 'EFFORT', 'DELEGATIONS', 'FRICTIONS']) expect(rows.findIndex((r) => r.startsWith(s))).toBeGreaterThan(claude)
  const brief = rows.findIndex((r) => r.startsWith('SELF-CALIBRATION BRIEF'))
  expect(rows[brief + 1]).toBe('Self-calibration (zetetic-insights ledger, last 5 sessions). Measured, not prescribed:')
  // A long "- " line wraps under its own text.
  expect(rows[brief + 2]!.startsWith('- main thread on opus/fable: 25%')).toBe(true)
  expect(rows[brief + 3]!.startsWith('  ')).toBe(true)
  expect(Math.max(...rows.map((r) => r.length))).toBeLessThanOrEqual(100)
})

test('no brief says so in the FOR CLAUDE band', () => {
  const rows = paintCells(sceneOf(null, null, 5), 90).glyphRows().map((r) => r.trimEnd())
  expect(rows).toContain('no brief this session: the ledger had nothing to say when it started')
})
