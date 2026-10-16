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
  const policy = scene.policy ?? { decisions: [], pressure: 'none' }
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

test('a turn records its graded base, the pressure it ran under and the runs the stuck escalation raised', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  const runs = [
    { phase: 'test', effort: 'medium', steps: 30, errors: 3, since: 5 },
    { phase: 'test', effort: 'high', steps: 1, errors: 0, since: 7 },
  ]
  const stuck = { at: 7, kind: 'stuck', subject: 'main step 3 (claude-opus-5-5)', from: 'medium', to: 'high', applied: true }
  stubs(on, w, { phases: turnWith(runs), policy: { decisions: [{ ...stuck, at: 2 }, stuck], pressure: 'quota' } }) // the first decision is an earlier turn's
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  const rec = (w.store['turns:sess-1'] as { base?: string; pressured?: true; stuck: number; main: { effort: string; escalated?: true }[] }[])[0]!
  expect(rec).toMatchObject({ base: 'high', pressured: true, stuck: 1 })
  expect(rec.main.map((r) => [r.effort, r.escalated])).toEqual([['medium', undefined], ['high', true]])
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
