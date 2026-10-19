import { expect, test } from 'claude-code/testing'

import type { Calibration, Credit, Move, Phase, Proposal, TurnRecord, Verdict } from '../types'
import { effectLine, effectOf, effectsOf, MOVES_CAP, movesOf, movesWith, snapshotOf } from './effect'
import { applied, emptyCalibration } from './learn'
import { type Stuck, type TimedRun, withEscalation } from './reach'
import { type Cell, cellsOf, decisions } from './rungs'

// A run of a turn graded `high` (so a ceiling at medium or low governs it) unless `extra` says otherwise.
const cell = (effort: string, session: string, at: number, steps: number, errors: number, taskClass = 'bugfix', phase: Phase = 'review', extra: Partial<Cell> = {}): Cell => ({ phase, effort, taskClass, session, at, steps, errors, base: 'high', escalated: false, pressured: false, unenforced: false, decisionsLost: false, ...extra })
const proposal = (to: 'low' | 'medium' | 'high', from: 'high' | 'medium' | 'low' = 'medium', phase: Phase = 'review'): Proposal => ({ phase, from, to, evidence: 'e', rate: { errors: 0, steps: 1, lo: 0, hi: 1 }, reference: { errors: 0, steps: 1, lo: 0, hi: 1 } })
const AT = 100

// Before the move: review at medium in bugfix and critical, five sessions; after: review at low in bugfix only.
const before = (steps: number, errors: number): Cell[] => ['s1', 's2', 's3', 's4', 's5'].flatMap((s, i) => [cell('medium', s, 10 + i, steps, errors), cell('medium', s, 20 + i, steps, errors, 'critical')])
const after = (steps: number, errors: number): Cell[] => ['s6', 's7', 's8', 's9', 's10'].map((s, i) => cell('low', s, 200 + i, steps, errors))
const verdicts = (ids: string[], v: Verdict): Map<string, Verdict> => new Map(ids.map((s) => [s, v]))

test('a snapshot is the phase runs at one effort by task class, with each session outcome under its 8-character key', () => {
  const snap = snapshotOf([cell('medium', 'abcdef123456', 1, 10, 2), cell('medium', 'abcdef123456', 2, 5, 0, 'critical'), cell('low', 'zzz', 3, 9, 9)], verdicts(['abcdef123456'], 'achieved'), 'review', 'medium', 'medium', 'low')
  expect(snap).toEqual({ byClass: { bugfix: { steps: 10, errors: 2 }, critical: { steps: 5, errors: 0 } }, sessions: { abcdef12: 'achieved' } })
})

test('a move freezes the runs before it; the previous move of the same phase is closed with the runs it governed', () => {
  const cells = [...before(20, 4), cell('low', 's6', 150, 10, 1), cell('low', 's6', 160, 10, 1)]
  const first = movesWith(emptyCalibration(), [proposal('low')], AT, cells, new Map())
  expect(first.length).toBe(1)
  expect(first[0]).toMatchObject({ phase: 'review', at: AT, from: 'medium', to: 'low', post: null })
  expect(first[0]!.pre.byClass).toEqual({ bugfix: { steps: 100, errors: 20 }, critical: { steps: 100, errors: 20 } })
  const second = movesWith({ ...emptyCalibration(), moves: first }, [proposal('high', 'low')], 300, cells, new Map())
  expect(second.length).toBe(2)
  expect(second[0]!.post?.byClass).toEqual({ bugfix: { steps: 20, errors: 2 } })
  expect(second[1]).toMatchObject({ from: 'low', to: 'high', post: null })
  // another phase's proposal leaves the open move open
  expect(movesWith({ ...emptyCalibration(), moves: first }, [proposal('high', 'medium', 'test')], 300, cells, new Map())[0]!.post).toBeNull()
})

test('the move is credited with harm only on a comparison of the same phase and the same task classes', () => {
  const m = movesWith(emptyCalibration(), [proposal('low')], AT, before(40, 2), new Map())[0]!
  const effect = effectOf(m, after(40, 14), new Map())
  expect(effect.classes).toEqual(['bugfix']) // critical ran only before: not compared
  expect(effect.preSide).toMatchObject({ steps: 200, errors: 10 })
  expect(effect.postSide).toMatchObject({ steps: 200, errors: 70 })
  expect(Math.abs(effect.failed.d - 0.3)).toBeLessThan(0.001)
  expect(effect.failed.lo).toBeGreaterThan(0)
  expect(effect.credit).toBe('harm')
})

test('fewer failed calls with confidence is a benefit; the same rate is inconclusive; no steps after is insufficient', () => {
  const m = movesWith(emptyCalibration(), [proposal('low')], AT, before(40, 12), new Map())[0]!
  expect(effectOf(m, after(40, 2), new Map())).toMatchObject({ credit: 'benefit' })
  expect(effectOf(m, after(40, 12), new Map())).toMatchObject({ credit: 'inconclusive' })
  expect(effectOf(m, [], new Map()).credit).toBe('insufficient')
  expect(effectOf(m, [cell('medium', 's6', 200, 40, 0)], new Map()).credit).toBe('insufficient') // the rung moved to never ran
  expect(effectOf(m, [cell('low', 's6', 200, 40, 0, 'analysis')], new Map()).credit).toBe('insufficient') // it ran, in no class the baseline has
})

test('the pre statistics survive the ledger trimming the runs they came from', () => {
  const m = movesWith(emptyCalibration(), [proposal('low')], AT, before(40, 2), new Map())[0]!
  const trimmed = after(40, 2) // the pre runs are gone from the ledger
  expect(effectOf(m, trimmed, new Map()).preSide.steps).toBe(200)
})

test('the outcome is compared on judged sessions; a session with runs on both sides belongs to neither', () => {
  const pre = verdicts(['s1', 's2', 's3', 's4', 's5'], 'achieved')
  const m = movesWith(emptyCalibration(), [proposal('low')], AT, before(40, 2), pre)[0]!
  const post = new Map<string, Verdict>([...verdicts(['s6', 's7', 's8', 's9', 's10'], 'not-achieved'), ['s1', 'not-achieved']])
  const straddle = [...after(40, 2), cell('low', 's1', 300, 10, 0)]
  const effect = effectOf(m, straddle, post)
  expect(effect.preSide.judged).toBe(4) // s1 dropped from the pre side
  expect(effect.postSide.judged).toBe(5) // and from the post side
  expect(Math.abs((effect.outcome?.d ?? 0) + 1)).toBeLessThan(1e-9)
  expect(effect.outcome?.hi).toBeLessThan(0)
  expect(effect.credit).toBe('harm')
  expect(effectOf(m, after(40, 2), new Map()).outcome).toBeNull() // no judged session after: no outcome claim
})

test('effectLine states the delta in points with its interval and the steps; one move gives its phase that credit', () => {
  const first = movesWith(emptyCalibration(), [proposal('low')], AT, before(40, 12), new Map())
  const moves: Move[] = [...first]
  const { effects, credits } = effectsOf(moves, after(40, 2), new Map())
  expect(credits.get('review')).toBe('benefit')
  expect(effectLine(effects[0]!)).toMatch(/^review medium -> low: failed calls -2\d pts \[-\d+, -\d+\] \(200 -> 200 steps\); benefit$/)
})

const sess = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`)
const proposeRaise = (): Proposal => proposal('high', 'medium', 'test')
const tcell = (effort: string, session: string, at: number, steps: number, errors: number, taskClass: string, extra: Partial<Cell> = {}): Cell => cell(effort, session, at, steps, errors, taskClass, 'test', extra)

// Pearl's reading of the population a move changed (hooks/reach.ts): a step sits on a rung because of its
// graded base, the ceiling, and, apart from the move, the autopilot's stuck escalation and pressure. Only
// steps whose rung the ceiling decided are comparable before and after; the others are not the move's.

// Probe P1 (review of #26): turns with no grade take the model's default as their base, so a raise reaches
// an unknown share of them. Their failures are the same before and after (40%, and 10% for the capped
// ones): the move changed nothing, and the old comparison read a 15-point benefit out of the mix.
test('P1 turns without a graded base are not the move population: a raise that changed nothing is not a benefit', () => {
  const unknown = { base: null }
  const pre = sess('p', 10).flatMap((s, i) => [tcell('medium', `${s}m`, 10 + i, 30, 12, 'unclassified', unknown), tcell('medium', `${s}h`, 30 + i, 30, 3, 'unclassified', unknown)])
  const post = sess('q', 10).flatMap((s, i) => [tcell('medium', `${s}m`, 200 + i, 30, 12, 'unclassified', unknown), tcell('high', `${s}h`, 230 + i, 30, 3, 'unclassified', unknown)])
  const m = movesWith(emptyCalibration(), [proposeRaise()], AT, pre, new Map())[0]!
  const e = effectOf(m, [...pre, ...post], new Map())
  expect(e.credit).not.toBe('benefit')
  expect(e.preSide.steps).toBe(0) // nothing attributable to the move: no baseline, no claim
  expect(e.credit).toBe('no-baseline')
})

// Probe P3: the autopilot raises a step one notch after 3 failed calls in a row (policy.ts escalate). A
// bugfix turn (base medium) that got stuck ran those steps at high whatever the ceiling: they make the
// class "shared" and, failing a lot, read as harm of a raise that left the critical turns at 10% before and after.
test('P3 stuck-escalated steps do not make a no-op raise read as harm', () => {
  const pre = [...sess('a', 5).map((s, i) => tcell('medium', s, 10 + i, 100, 10, 'critical')), ...sess('b', 5).map((s, i) => tcell('medium', s, 20 + i, 100, 10, 'bugfix', { base: 'medium' }))]
  const post = [
    ...sess('c', 5).map((s, i) => tcell('high', s, 200 + i, 100, 10, 'critical')),
    ...sess('d', 5).map((s, i) => tcell('medium', s, 210 + i, 100, 10, 'bugfix', { base: 'medium' })),
    ...sess('d', 5).map((s, i) => tcell('high', s, 211 + i, 20, 12, 'bugfix', { base: 'medium', escalated: true })),
  ]
  const m = movesWith(emptyCalibration(), [proposeRaise()], AT, pre, new Map())[0]!
  const e = effectOf(m, [...pre, ...post], new Map())
  expect(e.classes).toEqual(['critical'])
  expect(e.postSide.steps).toBe(500)
  expect(e.credit).toBe('inconclusive')
})

test('a move is credited only on steps its ceiling decided: base below the rung it reaches, stuck-escalated and pressured steps are left out of both sides', () => {
  const left = { base: 'medium' } // a medium base never reaches a ceiling above medium
  const cells = [
    tcell('medium', 'g1', 10, 100, 10, 'critical'), // governed
    tcell('medium', 'g2', 11, 100, 90, 'bugfix', left), // base below `high`
    tcell('medium', 'g3', 12, 100, 90, 'critical', { escalated: true }),
    tcell('medium', 'g4', 13, 100, 90, 'critical', { pressured: true }),
    tcell('medium', 'g5', 14, 100, 90, 'critical', { base: null }),
    tcell('low', 'g6', 15, 100, 90, 'critical'), // another rung
  ]
  expect(snapshotOf(cells, new Map(), 'test', 'medium', 'medium', 'high')).toEqual({ byClass: { critical: { steps: 100, errors: 10 } }, sessions: { g1: 'unclear' } })
})

test('a lowering move reaches the turns that ran at the rung left: the reach is the higher of the two rungs', () => {
  const cells = [tcell('high', 'h1', 10, 100, 10, 'critical'), tcell('high', 'h2', 11, 100, 90, 'bugfix', { base: 'medium' })]
  expect(snapshotOf(cells, new Map(), 'test', 'high', 'high', 'medium').byClass).toEqual({ critical: { steps: 100, errors: 10 } })
  expect(snapshotOf(cells, new Map(), 'test', 'high', 'medium', 'high').byClass).toEqual({ critical: { steps: 100, errors: 10 } }) // the same move read upwards
})

// M16, M17, M18: each side holds the runs of its own period only.
test('M16 the runs after the move are not in its pre statistics', () => {
  const m = movesWith(emptyCalibration(), [proposal('low')], AT, [...before(40, 2), cell('medium', 's9', AT + 50, 50, 50)], new Map())[0]!
  expect(m.pre.byClass).toEqual({ bugfix: { steps: 200, errors: 10 }, critical: { steps: 200, errors: 10 } })
})

test('M17 the runs before a move are not in the post statistics that a later move freezes', () => {
  const cells = [...before(20, 4), cell('low', 's0', 50, 40, 40), cell('low', 's6', 150, 10, 1)]
  const first = movesWith(emptyCalibration(), [proposal('low')], AT, cells, new Map())
  const second = movesWith({ ...emptyCalibration(), moves: first }, [proposal('high', 'low')], 300, cells, new Map())
  expect(second[0]!.post?.byClass).toEqual({ bugfix: { steps: 10, errors: 1 } })
})

test('M18 the runs before a move are not in the post of its effect while it is the last move', () => {
  const m = movesWith(emptyCalibration(), [proposal('low')], AT, before(40, 2), new Map())[0]!
  const e = effectOf(m, [cell('low', 's0', AT - 50, 100, 100), ...after(40, 2)], new Map())
  expect(e.postSide.steps).toBe(200)
})

test('M19 effectsOf credits each phase by its last move, not its first', () => {
  const snap = (steps: number, errors: number) => ({ byClass: { bugfix: { steps, errors } }, sessions: {} })
  const harmed: Move = { phase: 'review', at: 100, from: 'medium', to: 'low', pre: snap(100, 5), post: snap(100, 50) }
  const redone: Move = { phase: 'review', at: 300, from: 'low', to: 'medium', pre: snap(100, 50), post: null }
  const { effects, credits } = effectsOf([harmed, redone], [cell('medium', 's9', 400, 100, 5)], new Map())
  expect(effects.map((e) => e.credit)).toEqual(['harm', 'benefit'])
  expect(credits.get('review')).toBe('benefit')
})

test('M15 sessions achieved with confidence where they were not credit a benefit even when the failed calls did not move', () => {
  const ids = ['s1', 's2', 's3', 's4', 's5']
  const m = movesWith(emptyCalibration(), [proposal('low')], AT, before(40, 4), verdicts(ids, 'not-achieved'))[0]!
  const e = effectOf(m, after(40, 4), verdicts(['s6', 's7', 's8', 's9', 's10'], 'achieved'))
  expect(e.failed.lo).toBeLessThan(0)
  expect(e.failed.hi).toBeGreaterThan(0)
  expect(e.credit).toBe('benefit')
})

// Probe P2: a phase moved under 0.8.x has `changes` and no `moves`. Its move has no baseline, so no
// measurement can show it harmful; the rung evidence alone decides, as for any proposal.
const legacy = (): Calibration => ({ ...emptyCalibration(), phases: { test: 'high' }, changes: { test: { at: 1, from: 'medium', to: 'high' } }, moves: [] })
const undoEvidence = (): { cells: Cell[]; outcomes: Map<string, Verdict> } => ({
  cells: sess('t', 8).flatMap((s, i) => [tcell('high', s, 10 + i, 100, 0, 'bugfix'), cell('high', `r${i}`, 10 + i, 100, 40, 'bugfix', 'review')]),
  outcomes: verdicts(sess('t', 8), 'achieved'),
})

test('P2 a move made under 0.8.x (changes, no moves) has a defined state: no baseline', () => {
  const moves = movesOf(legacy())
  expect(moves).toHaveLength(1)
  expect(moves[0]).toMatchObject({ phase: 'test', at: 1, from: 'medium', to: 'high', post: null })
  expect(effectsOf(moves, [], new Map()).credits.get('test')).toBe('no-baseline')
  expect(movesOf(emptyCalibration())).toEqual([])
  // a move that has its entry in `moves` is not added twice
  const recorded = movesWith(emptyCalibration(), [proposeRaise()], 7, [], new Map())
  expect(movesOf({ ...emptyCalibration(), changes: { test: { at: 7, from: 'medium', to: 'high' } }, moves: recorded })).toHaveLength(1)
})

test('P2 a phase moved under 0.8.x can be undone when the evidence supports it; the same evidence with a measured, not-harmful move cannot', () => {
  const { cells, outcomes } = undoEvidence()
  const cal = legacy()
  const credits = effectsOf(movesOf(cal), cells, outcomes).credits
  expect(decisions(cells, outcomes, cal, credits).proposals.map((p) => `${p.phase} ${p.from}->${p.to}`)).toEqual(['test high->medium'])
  // P2c control: no recorded change, the same proposal
  expect(decisions(cells, outcomes, { ...cal, changes: {} }).proposals.map((p) => `${p.phase} ${p.from}->${p.to}`)).toEqual(['test high->medium'])
  // a move with a baseline that was not harmful holds the undo
  const measured = new Map<Phase, Credit>([['test', 'inconclusive']])
  expect(decisions(cells, outcomes, cal, measured).proposals).toEqual([])
})

// Probe P4 (review of #26, round 2): implementation is raised medium -> high while test stays at medium.
// In the hard turns (implementation 40% failed calls) test gets stuck and its next step is escalated to
// high; the easy turns run implementation at 10%. Same mix before and after: the raise changed nothing.
// Marking every run at high in a stuck turn dropped the hard implementation runs from the post side only.
const p4World = (ceiling: 'medium' | 'high', t0: number, prefix: string): TurnRecord[] =>
  Array.from({ length: 20 }, (_, i) => {
    const hard = i % 2 === 1
    const runs: TimedRun[] = [
      { phase: 'implementation', effort: ceiling, steps: 10, errors: hard ? 4 : 1, since: 1 },
      ...(hard ? [{ phase: 'test' as const, effort: 'medium', steps: 9, errors: 3, since: 20 }, { phase: 'test' as const, effort: 'high', steps: 1, errors: 0, since: 31 }] : []),
    ]
    const stuck: Stuck[] = hard ? [{ at: 30, to: 'high' }] : []
    return { session: `${prefix}${i}`, turnId: `${prefix}${i}`, at: t0 + i, taskClass: 'critical', base: 'high', main: withEscalation(runs, stuck), agents: [], advisor: { calls: 0, beforeWrite: 0, atCompletion: 0 }, stuck: stuck.length }
  })

test('P4 a stuck escalation in one phase does not take the other phases out: a raise that changed nothing is not a benefit', () => {
  const pre = cellsOf(p4World('medium', 10, 'p'))
  const post = cellsOf(p4World('high', 200, 'q'))
  const m = movesWith(emptyCalibration(), [proposal('high', 'medium', 'implementation')], AT, pre, new Map())[0]!
  const e = effectOf(m, [...pre, ...post], new Map())
  expect([e.preSide.errors, e.preSide.steps, e.postSide.errors, e.postSide.steps]).toEqual([50, 200, 50, 200])
  expect(e.credit).toBe('inconclusive')
})

// Probe P5: the moves kept are capped across phases; a phase's last move is what its undo is held to, so
// it is never the one trimmed. An evicted 0.9 move would be read as a 0.8.x one: no baseline, undo free.
const undoWorld = (): { cells: Cell[]; outcomes: Map<string, Verdict> } => {
  const ids = Array.from({ length: 8 }, (_, i) => `t${i}`)
  return {
    cells: ids.flatMap((s, i) => [cell('high', s, 10 + i, 100, 0, 'bugfix', 'test'), cell('high', `r${i}`, 10 + i, 100, 40, 'bugfix', 'review')]),
    outcomes: new Map(ids.map((s) => [s, 'achieved' as Verdict])),
  }
}

test('P5 the last move of a phase is never trimmed from the file: its frozen pre statistics and the hold on its undo survive later moves', () => {
  const { cells, outcomes } = undoWorld()
  const testMove: Move = { phase: 'test', at: 1, from: 'medium', to: 'high', pre: { byClass: { bugfix: { steps: 800, errors: 0 } }, sessions: {} }, post: null }
  let cal: Calibration = { ...emptyCalibration(), phases: { test: 'high' }, changes: { test: { at: 1, from: 'medium', to: 'high' } }, moves: [testMove] }
  const testProposals = (): Proposal[] => decisions(cells, outcomes, cal, effectsOf(movesOf(cal), cells, outcomes).credits).proposals.filter((p) => p.phase === 'test')
  expect(effectsOf(movesOf(cal), cells, outcomes).credits.get('test')).toBe('inconclusive')
  expect(testProposals()).toEqual([])
  for (let k = 0; k < MOVES_CAP; k++) {
    const ps = [k % 2 === 0 ? proposal('medium', 'high') : proposal('high', 'medium')]
    cal = applied(cal, ps, 2 + k, movesWith(cal, ps, 2 + k, [], new Map()))
  }
  expect(cal.moves.length).toBe(MOVES_CAP)
  expect(cal.moves.find((m) => m.phase === 'test')).toEqual(testMove)
  expect(cal.moves[cal.moves.length - 1]).toMatchObject({ phase: 'review', at: 1 + MOVES_CAP }) // the newest is kept, the oldest review moves went
  expect(effectsOf(movesOf(cal), cells, outcomes).credits.get('test')).toBe('inconclusive')
  expect(testProposals()).toEqual([])
})

// Finding E: with no graded turn (zetetic-genius absent or not grading) no step is governed, so a 0.9 move
// freezes an empty pre and is credited no-baseline like a 0.8.x one: its undo is decided by the rung
// evidence alone (the leave-one-out), the harm gate never applies. Holding it instead would hold it for good.
test('E a move made on ungraded turns has no baseline, and its undo is decided by the rung evidence alone', () => {
  const ids = Array.from({ length: 8 }, (_, i) => `u${i}`)
  const ungraded = { base: null }
  const pre = ids.map((s, i) => cell('medium', s, 10 + i, 100, 40, 'unclassified', 'test', ungraded))
  const m = movesWith(emptyCalibration(), [proposal('high', 'medium', 'test')], AT, pre, new Map())[0]!
  expect(m.pre.byClass).toEqual({})
  expect(effectOf(m, pre, new Map()).credit).toBe('no-baseline')
  // after the raise, test at high fails 2% against 40% elsewhere, every session achieved: the lowering back is proposed
  const post = ids.flatMap((s, i) => [cell('high', s, 200 + i, 100, 2, 'unclassified', 'test', ungraded), cell('high', `o${i}`, 200 + i, 100, 40, 'unclassified', 'review', ungraded)])
  const cal: Calibration = { ...emptyCalibration(), phases: { test: 'high' }, changes: { test: { at: AT, from: 'medium', to: 'high' } }, moves: [m] }
  const outcomes = new Map(ids.map((s) => [s, 'achieved' as Verdict]))
  const credits = effectsOf(movesOf(cal), post, outcomes).credits
  expect(decisions(post, outcomes, cal, credits).proposals.map((p) => `${p.phase} ${p.from}->${p.to}`)).toEqual(['test high->medium'])
})
