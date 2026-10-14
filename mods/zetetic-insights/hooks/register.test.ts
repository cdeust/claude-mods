import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Wiring: a main turn's runs go to the ledger, the evidence becomes a proposal, /calibrate apply
// writes the file the autopilot reads; enforced, the file is written at once.

const CAL = '/home/t/.claude/zetetic-insights/calibration.json'

type World = { files: Record<string, string>; written: Record<string, string>; store: Record<string, unknown>; storeDenied?: string }

// A main turn of 40 test steps at medium, 12 of them with a failed call: enough to raise.
const PHASES = {
  turnId: 't1',
  loops: [
    {
      id: 'main',
      type: 'main',
      description: 'main loop',
      model: 'claude-opus-5-5',
      effort: 'medium',
      phase: 'test',
      runs: [{ phase: 'test', effort: 'medium', steps: 40, errors: 12, since: 5 }],
      status: 'running',
      advisorCalls: 0,
      wrote: true,
      updatedAt: 6,
    },
  ],
  advisor: { session: 0, uses: [] },
}

// source: claude-code types, `$.store.set` rejects "a store over 4 MiB of JSON text in all".
const STORE_LIMIT = 4 * 1024 * 1024
// The store file is indented JSON (read 2026-10-14); the stricter of the two readings of the limit.
const storeBytes = (store: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(store, null, 2)).length

const stubs = (on: Parameters<TestBody>[1], w: World, phases: unknown = PHASES) => {
  mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/r' }))
  on('session.cwd', () => ({ value: '/r' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('env.get', ($, e) => ({ value: ((e as { name?: string }).name === 'HOME' ? '/home/t' : undefined) as never }))
  on('fs.exists', ($, e) => ({ value: String((e as { path?: string }).path) in w.files }))
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
  on('store.get', ($, e) => (w.storeDenied !== undefined ? { deny: w.storeDenied } : { value: w.store[String((e as { key?: string }).key)] as never }))
  on('store.set', ($, e) => {
    const { key, value } = e as unknown as { key: string; value: unknown }
    if (storeBytes({ ...w.store, [key]: value }) > STORE_LIMIT) return { deny: 'store over 4 MiB' }
    w.store[key] = value
    return { value: undefined as never }
  })
  on('command.register', () => ({ value: undefined as never }))
  on('state.get', ($, e, next) => {
    const plugin = (e as { plugin?: string }).plugin
    if (plugin === 'zetetic-autopilot')
      return { value: { value: ((e as { key?: string }).key === 'phases' ? phases : { decisions: [] }) as never, version: 1 } }
    if (plugin === 'zetetic-genius') return { value: { value: { classified: { turnId: 't1', taskClass: 'bugfix' } } as never, version: 1 } }
    return next(e)
  })
  on('turn.complete', () => ({ text: '' }))
}

test('observe: a main turn is kept in the ledger and its evidence proposed, not applied', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  const ledger = w.store.turns as { session: string; taskClass: string; mainModel: string; main: unknown[] }[]
  expect(ledger.length).toBe(1)
  expect(ledger[0]?.session).toBe('sess-1')
  expect(ledger[0]?.taskClass).toBe('bugfix')
  expect(ledger[0]?.mainModel).toBe('claude-opus-5-5')
  expect(w.written[CAL]).toBe(undefined)
  const shown = await $.command.run({ command: 'calibrate' } as never)
  expect(shown.text).toMatch(/^Ledger: 1 turns over 1 sessions, 0 judged by \/insights\./)
  expect(shown.text).toMatch(/Proposals: test medium → high \(12 failed calls in 40 steps at medium over 1 sessions\)/)
  const done = await $.command.run({ command: 'calibrate', args: 'apply' } as never)
  expect(done.text).toBe('Applied: test medium → high.')
  expect(JSON.parse(w.written[CAL] ?? '{}').phases).toEqual({ test: 'high' })
})

test('enforce: the proposal is written to the calibration file as soon as it is made', { options: { learning_mode: 'enforce' } }, async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  expect(JSON.parse(w.written[CAL] ?? '{}').phases).toEqual({ test: 'high' })
})

test('a calibration file that is not the expected shape is named, not read as empty', async ($, on) => {
  const w: World = { files: { [CAL]: '{"phases":{}}' }, written: {}, store: {} }
  stubs(on, w)
  let state: { calibrationError?: string | null } = {}
  on('state.set', ($, e, next) => {
    if ((e as { key?: string }).key === 'insights') state = (e as unknown as { value: typeof state }).value
    return next(e)
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  expect(state.calibrationError).toMatch(/not version 1/)
})

test('the steps by model: the main run is counted under its model family, one session row', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w)
  let state: { models?: unknown } = {}
  on('state.set', ($, e, next) => {
    if ((e as { key?: string }).key === 'insights') state = (e as unknown as { value: typeof state }).value
    return next(e)
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  // 40 main steps on claude-opus-5-5 (PHASES), no agents, clock 1000.
  expect(state.models).toEqual([{ session: 'sess-1', at: 1000, steps: [{ family: 'opus', steps: 40 }] }])
})

const record = (i: number, session = 'old') => ({
  session,
  turnId: `old-${i}`,
  at: i,
  taskClass: null,
  main: [{ phase: 'analysis', effort: 'medium', steps: 1, errors: 0 }],
  agents: Array.from({ length: 50 }, (_, j) => ({ type: `a${j}-${'x'.repeat(150)}`, phase: 'analysis', model: 'claude-haiku-5-5', steps: 1, errors: 0 })),
  advisor: { calls: 0, beforeWrite: 0, atCompletion: 0 },
  stuck: 0,
})

test('a ledger past the store limit is trimmed, and the next turn is saved', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { turns: Array.from({ length: 420 }, (_, i) => record(i)) } }
  expect(storeBytes(w.store)).toBeGreaterThan(STORE_LIMIT)
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  const kept = w.store.turns as { turnId: string }[]
  expect(kept[kept.length - 1]?.turnId).toBe('t1')
  expect(storeBytes(w.store)).toBeLessThanOrEqual(3 * 1024 * 1024)
})

test('a malformed facet is skipped and named, the others are read', async ($, on) => {
  const facets = '/home/t/.claude/usage-data/facets'
  const w: World = {
    files: { [facets]: '', [`${facets}/bad.json`]: '{oops', [`${facets}/good.json`]: '{"outcome":"fully_achieved"}' },
    written: {},
    store: { turns: [record(1, 'bad'), record(2, 'good')] },
  }
  stubs(on, w)
  let state: { facetsError?: string | null; judgedSessions?: number } = {}
  on('state.set', ($, e, next) => {
    if ((e as { key?: string }).key === 'insights') state = (e as unknown as { value: typeof state }).value
    return next(e)
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  expect(state.judgedSessions).toBe(1)
  expect(state.facetsError).toMatch(/^1 skipped, first bad: facet is not valid JSON/)
})

test('a store that cannot be read is named and the session starts a new ledger', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {}, storeDenied: 'store unreadable' }
  stubs(on, w)
  let state: { ledgerError?: string | null; turns?: number } = {}
  on('state.set', ($, e, next) => {
    if ((e as { key?: string }).key === 'insights') state = (e as unknown as { value: typeof state }).value
    return next(e)
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  expect(state.ledgerError).toMatch(/store unreadable/)
  expect(state.turns).toBe(0)
})

test("an agent finishing after main's turn completed joins that turn's record", async ($, on) => {
  const agentLoop = { ...PHASES.loops[0]!, id: 'a1', type: 'Explore', model: 'claude-haiku-5-5', phase: 'analysis', runs: [{ phase: 'analysis', effort: 'low', steps: 3, errors: 1, since: 7 }] }
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w, { ...PHASES, loops: [...PHASES.loops, agentLoop] })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  await $.turn.complete({ turnId: 'g1', reason: 'answer', agentId: 'a1' } as never)
  const ledger = w.store.turns as { turnId: string; agents: { type: string; steps: number }[] }[]
  expect(ledger.length).toBe(1)
  expect(ledger[0]?.agents).toEqual([{ type: 'Explore', phase: 'analysis', model: 'claude-haiku-5-5', steps: 3, errors: 1 }])
})
