// The scene painted into one grid of cells, in two bands: FOR YOU (what ran: the lanes, the model per
// step, the share of steps, the learning curves) and FOR CLAUDE (what reaches the model: the brief in
// its system prompt, the effort the autopilot runs each phase at, and the live evidence the next
// brief is made from). Pure; the register file hands the grid to a `Raster`.

import { Grid, MAX_COLUMNS, MAX_ROWS } from './grid'
import { CRITICAL, GRID, INK, INK_2, MUTED, SURFACE, familyColor, phaseColor } from './palette'
import { FAMILIES, curveScale, curveSummary, type Curve, type Gauge, type Lane, type ModelFamily, type ModelSteps, type Scene, PROBE_STEPS, WINDOW_MS, columnOf, cutsOf, familyOf, rung, sequenceOf, stepLane, windowLane } from './scene'

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

export const probeNote = (scene: Scene): string => `+${scene.models.probes} probe session${scene.models.probes === 1 ? '' : 's'} hidden (${PROBE_STEPS} step or fewer)`

export const IDLE = `idle: no agent in the last ${WINDOW_MS / 60_000} min`

const pct = (r: number): string => `${Math.round(r * 100)}%`

// The DELEGATIONS section as lines of coloured pieces, shared by both painters. Every number is the
// insights field it names; the colour never carries the meaning alone (the count is printed).
export type Piece = { text: string; color: number }
const FLAGS = ['overkill', 'underpowered', 'undesigned', 'rerouted'] as const
const RECENT = 4 // source: own choice, the newest flagged delegations that fit under the counts

export const delegationLines = (scene: Scene): Piece[][] => {
  const d = scene.delegations
  const m = scene.mechanical
  const lines: Piece[][] = [[{ text: 'DELEGATIONS (judged against their DESIGN block)', color: INK }]]
  if (d == null) lines.push([{ text: 'no delegation judged yet', color: MUTED }])
  else {
    lines.push([{ text: `${d.total} delegations, ${d.designed} designed`, color: INK_2 }])
    const counts: Piece[] = []
    FLAGS.forEach((f, i) => {
      const n = d.flags?.[f] ?? 0
      counts.push({ text: `${i === 0 ? '' : '  '}${f} ${n}`, color: n > 0 ? CRITICAL : MUTED })
    })
    lines.push(counts)
    for (const r of (d.recent ?? []).slice(-RECENT).reverse())
      lines.push([{ text: `${r.type.slice(0, 14).padEnd(14)} ${familyOf(r.model)} ${r.effort ?? '-'} ${r.steps}st ${r.errors}x  ${r.flags.join(',')}`, color: INK_2 }])
  }
  if (m != null)
    lines.push([{ text: m.share == null ? 'main opus/fable: no measured step yet' : `main opus/fable: ${pct(m.share)} steps only Read/Grep/Glob, ${m.sessions} sessions`, color: m.share == null ? MUTED : INK_2 }])
  return lines
}

// The FRICTIONS section: the insights' recurring frictions, the first FRICTION_ROWS, one row each:
// the kind in KIND columns, in how many sessions (Ns), how many times (Mx), the signature. Nothing
// at all when the insights sends none (a version before 0.7.0). Printable ASCII only (a Raster
// refuses the rest), and every row cut to the pane's width.
const FRICTION_ROWS = 5 // source: own choice, the rows that fit under DELEGATIONS; the brief says only the top one
const KIND = 15 // source: the longest kind, "harness-refusal", is 15
const ascii = (s: string): string => s.replace(/[^\x20-\x7e]/g, '?')

export const frictionLines = (scene: Scene, columns: number): Piece[][] => {
  const f = scene.frictions
  if (f == null) return []
  const row = (text: string, color: number): Piece[] => [{ text: ascii(text).slice(0, columns), color }]
  const lines: Piece[][] = [row('FRICTIONS (recurring over the last sessions)', INK)]
  if (f.length === 0) lines.push(row('no friction recurs over 2 sessions yet', MUTED))
  for (const r of f.slice(0, FRICTION_ROWS)) lines.push(row(`${String(r.kind).slice(0, KIND).padEnd(KIND)} ${r.sessions}s ${r.count}x ${r.signature}`, INK_2))
  return lines
}



// Shared by both painters: the families' legend, the step lanes and the share bars, as lines of
// coloured pieces. A family's colour is always beside its printed name (the legend, the share rows).
const BLOCK = '\u2588'
const LIGHT = '\u2591'

// The families drawn in the model sections, in the fixed order.
export const familiesShown = (scene: Scene): ModelFamily[] => {
  const seen = new Set<ModelFamily>([
    ...scene.models.window.map((s) => s.family),
    ...scene.models.sessions.flatMap((s) => [...s.steps.map((m) => m.family), ...(sequenceOf(s) ?? []).map((m) => m.family)]),
  ])
  return FAMILIES.filter((f) => seen.has(f))
}

// A family's height in a step lane, cheap to dear, so the lane climbs like stairs and the colour is
// never the only cue: haiku a third, sonnet a half and more, opus near full, fable full; other and
// unknown a sliver (U+2581..U+2588 lower blocks).
const STEP: Record<ModelFamily, string> = { unknown: '\u2581', other: '\u2581', haiku: '\u2583', sonnet: '\u2585', opus: '\u2587', fable: '\u2588' }

export const legendLine = (scene: Scene): Piece[] =>
  familiesShown(scene).flatMap((f, i) => [
    { text: `${i === 0 ? '' : '   '}${STEP[f]}`, color: familyColor(f) },
    { text: ` ${f}`, color: INK_2 },
  ])

// A strip of families as pieces: one block per column at its family's height, runs of one family
// merged; null is a space.
export const stripPieces = (strip: readonly (ModelFamily | null)[]): Piece[] => {
  const out: Piece[] = []
  for (const f of strip) {
    const color = f === null ? SURFACE : familyColor(f)
    const glyph = f === null ? ' ' : STEP[f]
    const last = out[out.length - 1]
    if (last !== undefined && last.color === color) last.text += glyph
    else out.push({ text: glyph, color })
  }
  return out
}

const total = (steps: readonly ModelSteps[]): number => steps.reduce((n, s) => n + s.steps, 0)

// MODEL PER STEP: one lane per session shown, its steps in the order they ran over `track` columns.
export const MODEL_HEADER = 'MODEL PER STEP (last sessions, oldest step left; a column shows its dearest model, dearer is taller)'
export const sessionLines = (scene: Scene, track: number): Piece[][] =>
  scene.models.sessions.map((s) => {
    const seq = sequenceOf(s)
    const label: Piece = { text: s.session.slice(0, 8).padEnd(LABEL), color: INK_2 }
    if (seq === null) return [label, { text: 'step order not sent (zetetic-insights before 0.10)', color: MUTED }]
    return [label, ...stripPieces(stepLane(seq, track)), { text: ` ${total(seq)} st`, color: MUTED }]
  })

// SHARE OF STEPS: one row per family over the sessions shown, a bar of its share of the whole and
// the share and the count printed in full after it, never cut.
const share = (part: number, whole: number): string => {
  const p = Math.round((100 * part) / whole)
  return p === 0 && part > 0 ? '<1%' : `${p}%`
}

export const shareLines = (scene: Scene, track: number): Piece[][] => {
  const by = new Map<ModelFamily, number>()
  for (const s of scene.models.sessions) for (const m of s.steps) by.set(m.family, (by.get(m.family) ?? 0) + m.steps)
  const whole = [...by.values()].reduce((n, v) => n + v, 0)
  const head: Piece[] = [{ text: `SHARE OF STEPS (the ${scene.models.sessions.length} session${scene.models.sessions.length === 1 ? '' : 's'} above, ${whole} steps)`, color: INK }]
  if (whole === 0) return [head, [{ text: 'no session with a step yet', color: MUTED }]]
  const rows = FAMILIES.filter((f) => (by.get(f) ?? 0) > 0).map((f): Piece[] => {
    const n = by.get(f)!
    const filled = Math.min(track, Math.max(1, Math.round((n / whole) * track)))
    return [
      { text: f.padEnd(LABEL), color: INK_2 },
      { text: BLOCK.repeat(filled), color: familyColor(f) },
      { text: LIGHT.repeat(track - filled), color: GRID },
      { text: ` ${share(n, whole).padStart(4)}`, color: INK },
      { text: `  ${n}`, color: MUTED },
    ]
  })
  return [head, ...rows]
}

// The share bar's columns: what the row leaves after the label and the printed share and count.
export const shareTrack = (columns: number): number => Math.max(1, columns - LABEL - 14)

// The band that opens each half of the pane: its name, what it holds, a rule to the edge.
export const bandLine = (name: string, what: string, columns: number): Piece[] => {
  const head = `\u2500\u2500 ${name} `
  const rest = ` ${what} `
  return [
    { text: head.slice(0, columns), color: INK },
    { text: rest.slice(0, Math.max(0, columns - head.length)), color: MUTED },
    { text: '\u2500'.repeat(Math.max(0, columns - head.length - rest.length)), color: GRID },
  ]
}

// The brief as the model reads it, wrapped to the pane: a "- " line continues under its text.
export const BRIEF_HEADER = 'SELF-CALIBRATION BRIEF (end of the system prompt, frozen at session start)'
export const briefLines = (scene: Scene, columns: number): Piece[][] => {
  if (scene.brief == null) return [[{ text: 'no brief this session: the ledger had nothing to say when it started', color: MUTED }]]
  const out: Piece[][] = []
  for (const raw of scene.brief.split('\n').map(ascii)) {
    const indent = raw.startsWith('- ') ? '  ' : ''
    let line = raw
    while (line.length > columns) {
      const at = line.lastIndexOf(' ', columns)
      const cutAt = at > indent.length ? at : columns
      out.push([{ text: line.slice(0, cutAt), color: INK_2 }])
      line = indent + line.slice(cutAt).trimStart()
    }
    out.push([{ text: line, color: INK_2 }])
  }
  return out
}

// A line of pieces at (x, y); a glyph outside what the Raster takes is drawn as `?`.
const RASTER_OK = (c: number): boolean => (c >= 0x20 && c < 0x7f) || (c >= 0x2500 && c <= 0x259f) || (c >= 0x2800 && c <= 0x28ff)
function write(g: Grid, x: number, y: number, line: readonly Piece[]): void {
  for (const p of line)
    for (const ch of p.text) {
      const c = ch.codePointAt(0)!
      g.put(x++, y, RASTER_OK(c) ? c : 0x3f, p.color)
    }
}

function writeAll(g: Grid, top: number, lines: readonly Piece[][]): number {
  lines.forEach((line, i) => write(g, 0, top + i, line))
  return top + lines.length
}

function lanes(g: Grid, scene: Scene, top: number): number {
  const width = g.columns - LABEL
  if (scene.lanes.length === 0) {
    g.text(LABEL, top, IDLE, MUTED)
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
  // Under the lanes, on their time axis: the dearest model at work in each column.
  const y = top + scene.lanes.length * 2
  write(g, 0, y, [{ text: 'model', color: INK_2 }])
  write(g, LABEL, y, stripPieces(windowLane(scene, width)))
  return y + 1
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

function curve(g: Grid, c: Curve, scale: number, top: number): void {
  const width = g.columns - LABEL - RIGHT
  const dotsX = width * 2
  const dotsY = CURVE_ROWS * 4
  g.text(0, top, c.phase, INK_2)
  const at = (i: number): [number, number] => [
    LABEL * 2 + Math.round((i * (dotsX - 1)) / (c.rates.length - 1)),
    top * 4 + dotsY - 1 - Math.round((c.rates[i]! / scale) * (dotsY - 1)),
  ]
  for (let i = 1; i < c.rates.length; i++) g.line(...at(i - 1), ...at(i), phaseColor(c.phase))
  const s = curveSummary(c)
  g.text(LABEL + width + 1, top, `last ${pct(s.last)}`, INK)
  g.text(0, top + 1, `peak ${pct(s.peak)}`, MUTED) // under the name, so a 5% phase beside a 100% one still says how high it went
  g.text(LABEL + width + 1, top + 1, `n=${s.n}`, MUTED)
  if (c.moveAt !== null) {
    const x = Math.floor(at(c.moveAt)[0] / 2)
    g.put(x, top + CURVE_ROWS, 0x5e, INK)
    g.text(x + 2, top + CURVE_ROWS, (c.move ?? '').replace('→', '>'), INK_2)
  }
}

export const paintCells = (scene: Scene, columns: number): Grid => {
  const g = new Grid(Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, columns)), MAX_ROWS, SURFACE)
  const w = g.columns
  g.text(0, 0, 'MISSION CONTROL', INK)
  g.text(16, 0, `turn ${(scene.turnId ?? '-').slice(0, 8)} - ${scene.lanes.length === 0 ? 'idle' : `${scene.lanes.length} lane${scene.lanes.length === 1 ? '' : 's'}`}, last ${WINDOW_MS / 60_000} min`, MUTED)

  // FOR YOU: what ran, and how it went.
  write(g, 0, 2, bandLine('FOR YOU', 'what ran, and how it went', w))
  let y = lanes(g, scene, 4)
  const cuts = cutsOf(scene, w - LABEL)
  g.text(LABEL, y, `${duration(cuts.activeMs)} of work${cuts.columns.length === 0 ? '' : `, ${cuts.columns.length} pause${cuts.columns.length === 1 ? '' : 's'} cut`}`, MUTED)
  g.text(w - 3, y, 'now', MUTED)
  y += 2
  g.text(0, y, MODEL_HEADER.slice(0, w), INK)
  write(g, LABEL, y + 1, legendLine(scene))
  y += 2
  if (scene.models.sessions.length === 0) g.text(0, y++, 'no session in the ledger yet', MUTED)
  y = writeAll(g, y, sessionLines(scene, Math.max(1, w - LABEL - RIGHT)))
  if (scene.models.probes > 0) g.text(0, y++, probeNote(scene), MUTED)
  y = writeAll(g, y + 1, shareLines(scene, shareTrack(w))) + 1
  g.text(0, y, `FAILED CALLS PER STEP, BY PHASE${scene.curves.length === 0 ? '' : ` - one scale, 0-${pct(curveScale(scene.curves))}`}`, INK)
  y += 1
  if (scene.curves.length === 0) g.text(0, y, 'no phase has two points yet: the ledger fills as turns complete', MUTED)
  scene.curves.forEach((c, i) => curve(g, c, curveScale(scene.curves), y + i * (CURVE_ROWS + 1)))
  y += Math.max(1, scene.curves.length * (CURVE_ROWS + 1)) + 1

  // FOR CLAUDE: what reaches the model, and what it is made from.
  write(g, 0, y, bandLine('FOR CLAUDE', 'what the model reads, and what steers it', w))
  y += 2
  g.text(0, y++, BRIEF_HEADER.slice(0, w), INK)
  y = writeAll(g, y, briefLines(scene, w)) + 1
  y = gauges(g, scene.gauges, y) + 1
  g.text(0, y++, 'LIVE EVIDENCE (the next session\'s brief is made from it)', MUTED)
  y = writeAll(g, y, delegationLines(scene))
  const f = frictionLines(scene, w)
  if (f.length > 0) y = writeAll(g, y + 1, f)
  return g.cropped(y)
}
