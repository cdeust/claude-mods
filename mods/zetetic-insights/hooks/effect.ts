// What an applied move did. Pure. A move of a phase's effort is credited only with a comparison of the
// same phase, the same task classes and the same population before and after it: the steps its ceiling
// decided (hooks/reach.ts: graded base at least the move's reach, not stuck-escalated, not under pressure),
// the runs of the rung left, then of the rung moved to. The pre statistics are frozen into the move when it
// is made, so trimming the ledger never discards them; the post statistics are frozen when a later move of
// the same phase supersedes it. The difference carries its Newcombe interval (hooks/stats.ts).

import type { Calibration, Credit, DeltaInterval, Effect, Effort, Move, Phase, Proposal, Snapshot, Verdict } from '../types'
import { governs } from './reach'
import { type Cell } from './rungs'
import { newcombe } from './stats'

export const MOVES_CAP = 50 // source: own choice, the moves kept in the calibration file (~1 KB each): a phase moves a few times a week at most
const KEY_LENGTH = 8 // source: own choice, characters of a session id kept in a snapshot (the ids are UUIDs: 8 hex digits are unique enough within one ledger)

const key = (session: string): string => session.slice(0, KEY_LENGTH)

// The runs of `phase` at `effort` in `cells` that a move from `from` to `to` governs, as a snapshot; each
// session's outcome as given.
export const snapshotOf = (cells: readonly Cell[], outcomes: ReadonlyMap<string, Verdict>, phase: Phase, effort: string, from: Effort, to: Effort): Snapshot => {
  const snap: Snapshot = { byClass: {}, sessions: {} }
  for (const c of cells) {
    if (c.phase !== phase || c.effort !== effort || !governs(c, from, to)) continue
    const row = snap.byClass[c.taskClass] ?? { steps: 0, errors: 0 }
    snap.byClass[c.taskClass] = { steps: row.steps + c.steps, errors: row.errors + c.errors }
    snap.sessions[key(c.session)] = outcomes.get(c.session) ?? 'unclear'
  }
  return snap
}

const emptySnapshot = (): Snapshot => ({ byClass: {}, sessions: {} })

// The move made now: pre is the phase's runs at the rung left, up to now. The previous move of the same
// phase, if still open, is closed with the runs it governed since.
export const movesWith = (c: Calibration, ps: readonly Proposal[], at: number, cells: readonly Cell[], outcomes: ReadonlyMap<string, Verdict>): Move[] => {
  const moves = c.moves.map((m) => (m.post === null && ps.some((p) => p.phase === m.phase) ? { ...m, post: snapshotOf(cells.filter((x) => x.at > m.at), outcomes, m.phase, m.to, m.from, m.to) } : m))
  const added = ps.map((p) => ({ phase: p.phase, at, from: p.from, to: p.to, pre: snapshotOf(cells.filter((x) => x.at <= at), outcomes, p.phase, p.from, p.from, p.to), post: null }))
  return [...moves, ...added].slice(-MOVES_CAP)
}

type Side = Effect['preSide']

// One side's totals over the shared classes, and its judged / achieved sessions outside `drop` (the sessions on both sides).
const sideOf = (s: Snapshot, shared: ReadonlySet<string>, drop: ReadonlySet<string>): Side => {
  const side = { steps: 0, errors: 0, judged: 0, achieved: 0 }
  for (const [k, row] of Object.entries(s.byClass)) {
    if (!shared.has(k)) continue
    side.steps += row.steps
    side.errors += row.errors
  }
  for (const [k, o] of Object.entries(s.sessions)) {
    if (drop.has(k) || (o !== 'achieved' && o !== 'not-achieved')) continue
    side.judged += 1
    if (o === 'achieved') side.achieved += 1
  }
  return side
}

const creditOf = (failed: DeltaInterval, outcome: DeltaInterval | null, pre: Side, post: Side, baseline: boolean): Credit => {
  if (!baseline) return 'no-baseline'
  if (pre.steps === 0 || post.steps === 0) return 'insufficient'
  const harm = failed.lo > 0 || (outcome !== null && outcome.hi < 0)
  const benefit = failed.hi < 0 || (outcome !== null && outcome.lo > 0)
  return harm ? 'harm' : benefit ? 'benefit' : 'inconclusive'
}

// The effect of one move. `post` is the move's own frozen post when it has one, else the runs since it
// at the rung moved to. Sessions with runs on both sides of the move are left out of the outcome
// comparison (their outcome belongs to neither side), the failed-call comparison is on the shared classes.
export const effectOf = (m: Move, cells: readonly Cell[], outcomes: ReadonlyMap<string, Verdict>): Effect => {
  const post = m.post ?? snapshotOf(cells.filter((x) => x.at > m.at), outcomes, m.phase, m.to, m.from, m.to)
  const shared = new Set(Object.keys(m.pre.byClass).filter((k) => k in post.byClass))
  const both = new Set(Object.keys(m.pre.sessions).filter((k) => k in post.sessions))
  const preSide = sideOf(m.pre, shared, both)
  const postSide = sideOf(post, shared, both)
  const failed = newcombe({ k: postSide.errors, n: postSide.steps }, { k: preSide.errors, n: preSide.steps })
  const outcome = preSide.judged > 0 && postSide.judged > 0 ? newcombe({ k: postSide.achieved, n: postSide.judged }, { k: preSide.achieved, n: preSide.judged }) : null
  return { phase: m.phase, at: m.at, from: m.from, to: m.to, classes: [...shared].sort(), preSide, postSide, failed, outcome, credit: creditOf(failed, outcome, preSide, postSide, Object.values(m.pre.byClass).some((row) => row.steps > 0)) }
}

// The moves a calibration holds: those it recorded, and, for a phase whose last change has no recorded move
// (made under 0.8.x, whose file kept `changes` and no `moves`), a move with no pre statistics. Such a move
// is credited `no-baseline` (nothing was frozen when it was made), so it is neither protected from being
// undone nor unmeasured forever: the rung evidence decides, as for any proposal. Not written back: the next
// move of the phase replaces its `changes` entry.
export const movesOf = (c: Calibration): Move[] => [
  ...c.moves,
  ...Object.entries(c.changes).flatMap(([phase, ch]) => (ch === undefined || c.moves.some((m) => m.phase === phase && m.at === ch.at) ? [] : [emptyMove(phase as Phase, ch.at, ch.from, ch.to)])),
]

// The effect of each move, and the credit of each phase's last move (what undoing it is held to).
export const effectsOf = (moves: readonly Move[], cells: readonly Cell[], outcomes: ReadonlyMap<string, Verdict>): { effects: Effect[]; credits: Map<Phase, Credit> } => {
  const effects = moves.map((m) => effectOf(m, cells, outcomes))
  const credits = new Map<Phase, Credit>()
  for (const e of effects) credits.set(e.phase, e.credit)
  return { effects, credits }
}

const signed = (x: number): string => `${x >= 0 ? '+' : ''}${Math.round(100 * x)}`

// One line for the brief and /calibrate: the delta in points with its interval and the steps behind it.
export const effectLine = (e: Effect): string => {
  const failed = `failed calls ${signed(e.failed.d)} pts [${signed(e.failed.lo)}, ${signed(e.failed.hi)}] (${e.preSide.steps} -> ${e.postSide.steps} steps)`
  const outcome = e.outcome === null ? '' : `, sessions achieved ${signed(e.outcome.d)} pts [${signed(e.outcome.lo)}, ${signed(e.outcome.hi)}] (${e.preSide.judged} -> ${e.postSide.judged})`
  return `${e.phase} ${e.from} -> ${e.to}: ${failed}${outcome}; ${e.credit}`
}

export const emptyMove = (phase: Phase, at: number, from: Effort, to: Effort): Move => ({ phase, at, from, to, pre: emptySnapshot(), post: null })
