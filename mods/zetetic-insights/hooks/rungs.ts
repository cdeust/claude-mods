// The evidence per phase and effort, and the one-notch move of a phase's tool-loop effort it supports.
// Pure. The rung is a ceiling (zetetic-autopilot policy.ts effortFor: a turn runs at min(its graded base,
// the ceiling)), so what is read is the effort each run actually had, not the configured default. The
// rule has no constant of its own (hooks/stats.ts derives them); it is written out, with its sources,
// in docs/insights-outcome-model.md section 6.

import type { Calibration, Credit, Effort, Finding, Phase, PhaseStat, Proposal, RateInterval, TurnRecord, Verdict } from '../types'
import { LADDER, LOOP_DEFAULT } from './learn'
import { HALF_WIDTH, type Interval, isResolved, newcombe, wilson } from './stats'

export const UNCLASSIFIED = 'unclassified' // a turn the genius grade did not class

// One main run of one turn: the unit every statistic below pools.
// `base`: the graded effort of its turn (null: not graded); `escalated`, `pressured`: why else it sat on its rung (hooks/reach.ts).
export type Cell = { phase: Phase; effort: string; taskClass: string; session: string; at: number; steps: number; errors: number; base: string | null; escalated: boolean; pressured: boolean }

export const cellsOf = (records: readonly TurnRecord[]): Cell[] =>
  records.flatMap((r) =>
    r.main.map((run) => ({
      phase: run.phase,
      effort: run.effort ?? 'default',
      taskClass: r.taskClass ?? UNCLASSIFIED,
      session: r.session,
      at: r.at,
      steps: run.steps,
      errors: run.errors,
      base: r.base ?? null,
      escalated: run.escalated === true,
      pressured: r.pressured === true,
    })),
  )

export type Pool = { steps: number; errors: number; sessions: string[] }

export const pool = (cells: readonly Cell[]): Pool => ({
  steps: cells.reduce((n, c) => n + c.steps, 0),
  errors: cells.reduce((n, c) => n + c.errors, 0),
  sessions: [...new Set(cells.map((c) => c.session))],
})

const intervalOf = (p: Pool): Interval => wilson(p.errors, p.steps)
const asRate = (p: Pool, iv: Interval): RateInterval => ({ errors: p.errors, steps: p.steps, lo: iv.lo, hi: iv.hi })
export const pct = (x: number): string => `${Math.round(100 * x)}%`
const span = (iv: Interval): string => `${pct(iv.p)} [${pct(iv.lo)}-${pct(iv.hi)}]`

export const notch = (effort: Effort, by: 1 | -1): Effort | undefined => LADDER[LADDER.indexOf(effort) + by]

// The achieved / judged sessions among `sessions`.
export const judgedOf = (sessions: readonly string[], outcomes: ReadonlyMap<string, Verdict>): { judged: number; achieved: number } => {
  const known = sessions.map((s) => outcomes.get(s)).filter((o) => o === 'achieved' || o === 'not-achieved')
  return { judged: known.length, achieved: known.filter((o) => o === 'achieved').length }
}

// Main's runs per phase and effort with the interval of their failed-call rate. Pre-move runs are kept:
// each run carries the effort it had, so the rows of every rung stand side by side.
export const phaseStats = (cells: readonly Cell[], outcomes: ReadonlyMap<string, Verdict>): PhaseStat[] => {
  const by = new Map<string, Cell[]>()
  for (const c of cells) by.set(`${c.phase}|${c.effort}`, [...(by.get(`${c.phase}|${c.effort}`) ?? []), c])
  return [...by.values()]
    .map((rows) => {
      const p = pool(rows)
      const iv = intervalOf(p)
      return { phase: rows[0]!.phase, effort: rows[0]!.effort, steps: p.steps, errors: p.errors, sessions: p.sessions.length, ...judgedOf(p.sessions, outcomes), lo: iv.lo, hi: iv.hi, resolved: isResolved(iv) }
    })
    .sort((a, b) => a.phase.localeCompare(b.phase) || a.effort.localeCompare(b.effort))
}

type Held = { dir: null; finding?: Omit<Finding, 'phase' | 'effort'> }
type Call = { dir: 'raise' | 'lower'; to: Effort; mine: Pool; ref: Pool; im: Interval; ir: Interval; achieved?: { judged: number; achieved: number } }
type Decision = Held | Call

const cellsAt = (cells: readonly Cell[], phase: Phase, effort: string, same: boolean): Cell[] => cells.filter((c) => (c.phase === phase) === same && c.effort === effort)

// Whether the rung moved to is confidently worse than the rung left, in the task classes both ran:
// the same phase, the same classes (a move is judged where a comparison is possible, never across mixes).
const neighbourWorse = (cells: readonly Cell[], phase: Phase, from: Effort, to: Effort): boolean => {
  const left = cellsAt(cells, phase, from, true)
  const right = cellsAt(cells, phase, to, true)
  const shared = new Set(left.map((c) => c.taskClass).filter((k) => right.some((c) => c.taskClass === k)))
  const a = pool(right.filter((c) => shared.has(c.taskClass)))
  const b = pool(left.filter((c) => shared.has(c.taskClass)))
  if (shared.size === 0 || !isResolved(intervalOf(a)) || !isResolved(intervalOf(b))) return false
  return newcombe({ k: a.errors, n: a.steps }, { k: b.errors, n: b.steps }).lo > 0
}

const decide = (cells: readonly Cell[], phase: Phase, rung: Effort, outcomes: ReadonlyMap<string, Verdict>): Decision => {
  const mine = pool(cellsAt(cells, phase, rung, true))
  const ref = pool(cellsAt(cells, phase, rung, false))
  const im = intervalOf(mine)
  const ir = intervalOf(ref)
  if (mine.steps === 0) return { dir: null, finding: { kind: 'unmeasured', note: `no step ran at ${rung}, the ceiling: the rung is unmeasured, the phase's other rows say nothing of it` } }
  if (!isResolved(im)) return { dir: null, finding: { kind: 'unresolved', note: `${mine.errors}/${mine.steps} steps failed at ${rung} (${span(im)}): wider than +-${pct(HALF_WIDTH)}` } }
  if (!isResolved(ir)) return { dir: null, finding: { kind: 'no-reference', note: `the other phases at ${rung} give ${ref.errors}/${ref.steps} steps (${span(ir)}): no resolved reference` } }
  const up = notch(rung, 1)
  const down = notch(rung, -1)
  if (im.lo > ir.hi && up !== undefined && !neighbourWorse(cells, phase, rung, up)) return { dir: 'raise', to: up, mine, ref, im, ir }
  if (im.hi < ir.lo && down !== undefined && !neighbourWorse(cells, phase, rung, down)) {
    const achieved = judgedOf(mine.sessions, outcomes)
    if (wilson(achieved.achieved, achieved.judged).lo > 0.5) return { dir: 'lower', to: down, mine, ref, im, ir, achieved }
    return { dir: null, finding: { kind: 'unresolved', note: `${rung} fails less than the other phases but ${achieved.achieved}/${achieved.judged} judged sessions achieved: not more than half with confidence` } }
  }
  return { dir: null }
}

// The same decision with each one session left out: the move stands only if none changes it.
const stable = (cells: readonly Cell[], phase: Phase, rung: Effort, outcomes: ReadonlyMap<string, Verdict>, call: Call): boolean =>
  [...new Set([...call.mine.sessions, ...call.ref.sessions])].every((s) => decide(cells.filter((c) => c.session !== s), phase, rung, outcomes).dir === call.dir)

const evidenceOf = (phase: Phase, rung: Effort, c: Call): string =>
  `${phase}: ${c.mine.errors}/${c.mine.steps} steps failed at ${rung} (${span(c.im)}) against ${c.ref.errors}/${c.ref.steps} in the other phases at ${rung} (${span(c.ir)}); ${c.mine.sessions.length} sessions, the verdict holds without any one of them${
    c.achieved === undefined ? '' : `; ${c.achieved.achieved}/${c.achieved.judged} judged sessions achieved`
  }`

// Rows at a rung below the ceiling that fail confidently more than the others: the ceiling cannot lift them
// (a turn runs at min(base, ceiling); its base comes from the request classifier), so no move is proposed.
const unreachable = (cells: readonly Cell[], phase: Phase, now: Effort): Finding[] =>
  LADDER.slice(0, LADDER.indexOf(now)).flatMap((rung) => {
    const mine = pool(cellsAt(cells, phase, rung, true))
    const ref = pool(cellsAt(cells, phase, rung, false))
    const im = intervalOf(mine)
    const ir = intervalOf(ref)
    if (!isResolved(im) || !isResolved(ir) || im.lo <= ir.hi) return []
    return [{ phase, effort: rung, kind: 'unreachable' as const, note: `${mine.errors}/${mine.steps} steps failed at ${rung} (${span(im)}) against ${span(ir)} elsewhere; the ceiling at ${now} cannot lift them, their effort is the grade's base` }]
  })

// A move is undone when its measured effect is harm, or when it has no baseline to be measured against
// (hooks/effect.ts movesOf): nothing can ever show it harmful, so holding it would hold it for good.
const mayUndo = (credit: Credit | undefined): boolean => credit === 'harm' || credit === 'no-baseline'

// One proposal per phase at most, and what held the others back. `credits`: the measured effect of each phase's last move.
export const decisions = (
  cells: readonly Cell[],
  outcomes: ReadonlyMap<string, Verdict>,
  calibration: Calibration,
  credits: ReadonlyMap<Phase, Credit> = new Map(),
): { proposals: Proposal[]; findings: Finding[] } => {
  const proposals: Proposal[] = []
  const findings: Finding[] = []
  for (const phase of new Set(cells.map((c) => c.phase))) {
    const now = calibration.phases[phase] ?? LOOP_DEFAULT
    findings.push(...unreachable(cells, phase, now))
    const d = decide(cells, phase, now, outcomes)
    if (d.dir === null) {
      if (d.finding !== undefined) findings.push({ phase, effort: now, ...d.finding })
      continue
    }
    const last = calibration.changes[phase]
    if (!stable(cells, phase, now, outcomes, d)) findings.push({ phase, effort: now, kind: 'unstable', note: `${d.dir} ${now} -> ${d.to} does not hold when one session is left out` })
    else if (last?.from === d.to && !mayUndo(credits.get(phase))) findings.push({ phase, effort: now, kind: 'held', note: `undoing ${last.from} -> ${last.to} needs that move's measured effect to be harm (it is ${credits.get(phase) ?? 'not measured'})` })
    else proposals.push({ phase, from: now, to: d.to, evidence: evidenceOf(phase, now, d), rate: asRate(d.mine, d.im), reference: asRate(d.ref, d.ir) })
  }
  return { proposals, findings }
}
