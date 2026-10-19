import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Wiring of the measured moves: what a turn records of why its runs sat on their rung, and that the
// automated path (enforce) freezes a move's pre statistics like /calibrate apply does.

const CAL = '/home/t/.claude/zetetic-insights/calibration.json'
type World = { files: Record<string, string>; written: Record<string, string>; store: Record<string, unknown> }

const turnWith = (runs: unknown[]) => ({
  turnId: 't1',
  loops: [{ id: 'main', type: 'main', description: 'main loop', model: 'claude-opus-5-5', effort: 'medium', phase: 'test', runs, status: 'running', advisorCalls: 0, wrote: true, updatedAt: 6 }],
  advisor: { session: 0, uses: [] },
})

type Scene = { phases: unknown; policy?: unknown }
const stubs = (on: Parameters<TestBody>[1], w: World, scene: Scene) => {
  const policy = scene.policy ?? { mode: 'enforce', decisions: [], pressure: 'none' }
  mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/r' }))
  on('session.cwd', () => ({ value: '/r' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('env.get', ($, e) => ({ value: ((e as { name?: string }).name === 'HOME' ? '/home/t' : undefined) as never }))
  on('fs.exists', ($, e) => ({ value: String((e as { path?: string }).path) in w.files }))
  on('fs.stat', ($, e) => (String((e as { path?: string }).path) in w.files ? { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } as never } : { deny: 'ENOENT' }))
  on('fs.read', ($, e) => {
    const text = w.files[String((e as { path?: string }).path)]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', ($, e) => {
    const { path, text } = e as unknown as { path: string; text: string }
    w.written[path] = text
    w.files[path] = text
    return { value: undefined as never }
  })
  on('store.get', ($, e) => ({ value: w.store[String((e as { key?: string }).key)] as never }))
  on('store.set', ($, e) => {
    const { key, value } = e as unknown as { key: string; value: unknown }
    w.store[key] = JSON.parse(JSON.stringify(value))
    return { value: undefined as never }
  })
  on('store.keys', () => ({ value: Object.keys(w.store) as never }))
  on('store.delete', ($, e) => {
    delete w.store[String((e as { key?: string }).key)]
    return { value: undefined as never }
  })
  on('command.register', () => ({ value: undefined as never }))
  on('state.get', ($, e, next) => {
    const plugin = (e as { plugin?: string }).plugin
    if (plugin === 'zetetic-autopilot') return { value: { value: ((e as { key?: string }).key === 'phases' ? scene.phases : policy) as never, version: 1 } }
    if (plugin === 'zetetic-genius') return { value: { value: { classified: { turnId: 't1', taskClass: 'critical', effort: 'high' } } as never, version: 1 } }
    return next(e)
  })
  on('turn.complete', () => ({ text: '' }))
}

// Four past sessions, graded high, that support a raise of `test`: 30% failed calls at medium against 3% in `analysis`.
const evidenceStore = (): Record<string, unknown> => {
  const store: Record<string, unknown> = {}
  for (const s of ['p1', 'p2', 'p3', 'p4']) {
    const run = (phase: string, errors: number) => ({ phase, effort: 'medium', steps: 30, errors })
    store[`turns:${s}`] = [{ session: s, turnId: `t-${s}`, at: 10, taskClass: 'critical', base: 'high', main: [run('test', 9), run('analysis', 1)], agents: [], advisor: { calls: 0, beforeWrite: 0, atCompletion: 0 }, stuck: 0, nonInteractive: false }]
    store[`ended:${s}`] = { at: 11 }
  }
  return store
}

type Rec = { base?: string; pressured?: true; unenforced?: true; decisionsLost?: true; stuck: number; main: { phase: string; effort: string; escalated?: true }[] }
const recorded = async ($: Parameters<TestBody>[0], w: World): Promise<Rec> => {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  return (w.store['turns:sess-1'] as Rec[])[0]!
}
// A turn where implementation ran at high, then test got stuck at medium and its next step was raised to high.
const stuckTurn = [
  { phase: 'implementation', effort: 'high', steps: 10, errors: 0, since: 3 },
  { phase: 'test', effort: 'medium', steps: 30, errors: 3, since: 5 },
  { phase: 'test', effort: 'high', steps: 1, errors: 0, since: 8 },
]
const stuckAt7 = { at: 7, kind: 'stuck', subject: 'main step 3 (claude-opus-5-5)', from: 'medium', to: 'high', applied: true }
const escalatedOf = (rec: Rec): [string, string, boolean][] => rec.main.map((r) => [r.phase, r.effort, r.escalated === true])

test('a turn records its graded base, the pressure it ran under and the run of the step the stuck escalation raised', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w, { phases: turnWith(stuckTurn), policy: { mode: 'enforce', decisions: [{ ...stuckAt7, at: 2 }, stuckAt7], pressure: 'quota' } }) // the first decision is an earlier turn's
  const rec = await recorded($, w)
  expect(rec).toMatchObject({ base: 'high', pressured: true, stuck: 1 })
  expect(rec.unenforced).toBeUndefined()
  expect(rec.decisionsLost).toBeUndefined()
  // implementation also ran at high: it was not the stuck phase's step and stays governed
  expect(escalatedOf(rec)).toEqual([['implementation', 'high', false], ['test', 'medium', false], ['test', 'high', true]])
})

test('C4 context pressure is recorded like quota pressure', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w, { phases: turnWith(stuckTurn), policy: { mode: 'enforce', decisions: [], pressure: 'context' } })
  expect((await recorded($, w)).pressured).toBe(true)
})

test('C1 only a stuck decision marks a run: an effort decision to the same rung is the ceiling or the base at work', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w, { phases: turnWith(stuckTurn), policy: { mode: 'enforce', decisions: [{ ...stuckAt7, kind: 'effort' }], pressure: 'none' } })
  const rec = await recorded($, w)
  expect(escalatedOf(rec).map(([, , e]) => e)).toEqual([false, false, false])
  expect(rec.stuck).toBe(0)
})

test('C3 a stuck decision that was not applied raised nothing and marks no run', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w, { phases: turnWith(stuckTurn), policy: { mode: 'enforce', decisions: [{ ...stuckAt7, applied: false }], pressure: 'none' } })
  expect(escalatedOf(await recorded($, w)).map(([, , e]) => e)).toEqual([false, false, false])
})

// The same turn as the autopilot 0.8.0 records it: each run carries `escalated`, the steps its stuck escalation raised.
const withCount = (counts: number[]) => stuckTurn.map((r, i) => ({ ...r, escalated: counts[i] }))

test('E the run holding a raised step is read from run.escalated, not joined to a decision by time: no decision is needed', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  // the escalation went back to the effort the step came with: the autopilot logged no decision, yet it counted the step on its run
  stubs(on, w, { phases: turnWith(withCount([0, 0, 1])), policy: { mode: 'enforce', decisions: [], pressure: 'none' } })
  expect(escalatedOf(await recorded($, w))).toEqual([['implementation', 'high', false], ['test', 'medium', false], ['test', 'high', true]])
})

test('E a run counted 0 is not marked, whatever a decision joined to it by time says', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  // the decision at 7 would join the run opened at 8; the autopilot counted no raised step there (and one on the run before it)
  stubs(on, w, { phases: turnWith(withCount([0, 1, 0])), policy: { mode: 'enforce', decisions: [stuckAt7], pressure: 'none' } })
  expect(escalatedOf(await recorded($, w)).map(([, , e]) => e)).toEqual([false, true, false])
})

test('E a full decision log loses nothing when every run carries its count: the turn is not decisionsLost', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w, { phases: turnWith(withCount([0, 0, 1])), policy: { mode: 'enforce', decisions: logOf(50, 3), pressure: 'none' } })
  const rec = await recorded($, w)
  expect(rec.decisionsLost).toBeUndefined()
  expect(escalatedOf(rec).map(([, , e]) => e)).toEqual([false, false, true])
})

test('E a turn with a run recorded before the count falls back to the time join and its decision-log guard for that run', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  const mixed = [stuckTurn[0]!, stuckTurn[1]!, { ...stuckTurn[2]!, escalated: 0 }] // only the last run has the count
  stubs(on, w, { phases: turnWith(mixed), policy: { mode: 'enforce', decisions: logOf(50, 3), pressure: 'none' } })
  expect((await recorded($, w)).decisionsLost).toBe(true)
})

test('E in a mixed turn a counted run is not placed by a decision, even one that would join it by time', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  const mixed = [stuckTurn[0]!, stuckTurn[1]!, { ...stuckTurn[2]!, escalated: 0 }]
  stubs(on, w, { phases: turnWith(mixed), policy: { mode: 'enforce', decisions: [stuckAt7], pressure: 'none' } })
  expect(escalatedOf(await recorded($, w)).map(([, , e]) => e)).toEqual([false, false, false]) // the counted last run, at the raised effort, is not joined to the decision
})

test('E under autopilot observe a counted run is still left out whole by unenforced', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w, { phases: turnWith(withCount([0, 0, 0])), policy: { mode: 'observe', decisions: [], pressure: 'none' } })
  const rec = await recorded($, w)
  expect(rec.unenforced).toBe(true)
  expect(escalatedOf(rec).map(([, , e]) => e)).toEqual([false, false, false])
})

test('C a turn under autopilot observe is recorded unenforced: no rung was the ceiling, the pressure or the escalation', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w, { phases: turnWith(stuckTurn), policy: { mode: 'observe', decisions: [{ ...stuckAt7, applied: false }], pressure: 'quota' } })
  const rec = await recorded($, w)
  expect(rec.unenforced).toBe(true)
  expect(rec.pressured).toBeUndefined() // the ladder was not held down: nothing was applied
  expect(escalatedOf(rec).map(([, , e]) => e)).toEqual([false, false, false])
})

test('C a turn with no readable autopilot policy is recorded unenforced', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w, { phases: turnWith(stuckTurn), policy: { decisions: [], pressure: 'none' } }) // no mode
  expect((await recorded($, w)).unenforced).toBe(true)
})

// The autopilot keeps its newest 50 decisions (zetetic-autopilot hooks/register.tsx DECISIONS_CAP).
const logOf = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ at: from + i / 100, kind: 'effort', subject: 'main step', from: 'medium', to: 'low', applied: true }))

test('D a turn whose decisions the autopilot log may have dropped is recorded decisionsLost', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w, { phases: turnWith(stuckTurn), policy: { mode: 'enforce', decisions: logOf(50, 3), pressure: 'none' } }) // full, the oldest taken when the turn's first run started (3)
  expect((await recorded($, w)).decisionsLost).toBe(true)
})

test('D a full log whose oldest decision is before the turn kept every decision of the turn', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w, { phases: turnWith(stuckTurn), policy: { mode: 'enforce', decisions: logOf(50, 2), pressure: 'none' } })
  expect((await recorded($, w)).decisionsLost).toBeUndefined()
})

test('D a log below its cap has dropped nothing', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w, { phases: turnWith(stuckTurn), policy: { mode: 'enforce', decisions: logOf(49, 6), pressure: 'none' } })
  expect((await recorded($, w)).decisionsLost).toBeUndefined()
})

// The move is made at session start, when the four past sessions already support it; the turn comes after.
test('M22 enforce freezes the move like /calibrate apply: the pre statistics of the steps it governed are in the file', { options: { learning_mode: 'enforce' } }, async ($, on) => {
  const w: World = { files: {}, written: {}, store: evidenceStore() }
  stubs(on, w, { phases: turnWith([{ phase: 'test', effort: 'medium', steps: 40, errors: 12, since: 5 }]) })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  const file = JSON.parse(w.written[CAL] ?? '{}')
  expect(file.phases).toEqual({ test: 'high' })
  expect(file.moves).toHaveLength(1)
  expect(file.moves[0]).toMatchObject({ phase: 'test', from: 'medium', to: 'high', post: null })
  expect(file.moves[0].pre.byClass.critical).toEqual({ steps: 120, errors: 36 })
})

test('P2 through the file: a 0.8.x calibration (changes, no moves) is read, its move undone when the evidence supports it', async ($, on) => {
  const legacy = { version: 1, phases: { test: 'low' }, evidence: {}, changes: { test: { at: 1, from: 'medium', to: 'low' } }, updatedAt: 1 } // no `moves`: the 0.8.x shape
  const store: Record<string, unknown> = {}
  for (const s of ['p1', 'p2', 'p3', 'p4']) {
    const run = (phase: string, errors: number) => ({ phase, effort: 'low', steps: 60, errors })
    store[`turns:${s}`] = [{ session: s, turnId: `t-${s}`, at: 10, taskClass: 'critical', base: 'high', main: [run('test', 18), run('review', 2)], agents: [], advisor: { calls: 0, beforeWrite: 0, atCompletion: 0 }, stuck: 0, nonInteractive: false }]
    store[`ended:${s}`] = { at: 11 }
  }
  const w: World = { files: { [CAL]: JSON.stringify(legacy) }, written: {}, store }
  stubs(on, w, { phases: turnWith([{ phase: 'test', effort: 'low', steps: 60, errors: 18, since: 5 }]) })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  const shown = await $.command.run({ command: 'calibrate' } as never)
  expect(shown.text).toMatch(/Proposals: test low → medium/)
  expect(shown.text).toMatch(/test medium -> low: .*no-baseline/)
})
