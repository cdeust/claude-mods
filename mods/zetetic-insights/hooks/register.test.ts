import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { FRICTION_MAX_BYTES } from './friction'

// Wiring: a main turn's runs go to the ledger, the evidence becomes a proposal, /calibrate apply
// writes the file the autopilot reads; enforced, the file is written at once.

const CAL = '/home/t/.claude/zetetic-insights/calibration.json'

// `store` is the one store every Claude process shares; `sid` is this process's session id. A second
// process is simulated by writing its keys into `store` directly: the kit hosts one plugin instance.
type World = { files: Record<string, string>; written: Record<string, string>; store: Record<string, unknown>; sizes?: Record<string, number>; readErrors?: Record<string, string>; storeDenied?: string; sid?: string; sidDenied?: string; afterSet?: (key: string) => void }

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
      runs: [{ phase: 'test', effort: 'medium', steps: 40, errors: 12, since: 5, reads: 25 }],
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

const stubs = (on: Parameters<TestBody>[1], w: World, phases: unknown = PHASES, now = 1_000) => {
  const clock = mock.clock(on, { now })
  on('session.start', () => ({ cwd: '/r' }))
  on('session.cwd', () => ({ value: '/r' }))
  on('session.id', () => (w.sidDenied !== undefined ? { deny: w.sidDenied } : { value: w.sid ?? 'sess-1' }))
  on('env.get', ($, e) => ({ value: ((e as { name?: string }).name === 'HOME' ? '/home/t' : undefined) as never }))
  on('fs.exists', ($, e) => ({ value: String((e as { path?: string }).path) in w.files }))
  on('fs.stat', ($, e) => {
    const path = String((e as { path?: string }).path)
    return !(path in w.files) ? { deny: 'ENOENT' } : { value: { kind: 'file', size: w.sizes?.[path] ?? 1, mtimeMs: 0, isLink: false } as never }
  })
  on('fs.read', ($, e) => {
    const path = String((e as { path?: string }).path)
    if (w.readErrors?.[path] !== undefined) return { deny: w.readErrors[path]! }
    const text = w.files[path]
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
    w.store[key] = JSON.parse(JSON.stringify(value))
    w.afterSet?.(key)
    return { value: undefined as never }
  })
  on('store.keys', () => (w.storeDenied !== undefined ? { deny: w.storeDenied } : { value: Object.keys(w.store) as never }))
  on('store.delete', ($, e) => {
    delete w.store[String((e as { key?: string }).key)]
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
  return clock
}

test('a run without reads is kept without them', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  const bare = { ...PHASES, loops: [{ ...PHASES.loops[0]!, runs: [{ phase: 'test', effort: 'medium', steps: 4, errors: 0, since: 5 }] }] }
  stubs(on, w, bare)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  expect((w.store['turns:sess-1'] as { main: unknown[] }[])[0]?.main).toEqual([{ phase: 'test', effort: 'medium', steps: 4, errors: 0 }])
})

test('observe: a main turn is kept in the ledger and its evidence proposed, not applied', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  const ledger = w.store['turns:sess-1'] as { session: string; taskClass: string; mainModel: string; main: unknown[] }[]
  expect(ledger.length).toBe(1)
  expect(ledger[0]?.session).toBe('sess-1')
  expect(ledger[0]?.taskClass).toBe('bugfix')
  expect(ledger[0]?.mainModel).toBe('claude-opus-5-5')
  expect(ledger[0]?.main).toEqual([{ phase: 'test', effort: 'medium', steps: 40, errors: 12, reads: 25 }])
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

// I4: the store over its limit, the finished session evicted with its keys, a live one kept.
test('a ledger past the store limit: the finished session is evicted, the live one kept, and the next turn is saved', async ($, on) => {
  const live = [{ ...record(990, 'live'), agents: [] }]
  const w: World = { files: {}, written: {}, store: { 'turns:old': Array.from({ length: 420 }, (_, i) => record(i)), 'ended:old': { at: 500 }, 'claim:old': { by: 'x', at: 1 }, 'turns:live': live } }
  expect(storeBytes(w.store)).toBeGreaterThan(STORE_LIMIT)
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  const kept = w.store['turns:sess-1'] as { turnId: string }[]
  expect(kept[kept.length - 1]?.turnId).toBe('t1')
  expect(Object.keys(w.store).sort()).toEqual(['turns:live', 'turns:sess-1'])
  expect(w.store['turns:live']).toEqual(live)
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
  const ledger = w.store['turns:sess-1'] as { turnId: string; agents: { type: string; steps: number }[] }[]
  expect(ledger.length).toBe(1)
  expect(ledger[0]?.agents).toEqual([{ agentId: 'a1', type: 'Explore', phase: 'analysis', model: 'claude-haiku-5-5', steps: 3, errors: 1 }])
})

const DESIGNED = 'DESIGN\ntask: look\ncheck: done\nmodel: opus · effort: high · why: hard\ngenius shape: operational-definition → einstein: measure it\n\nGo.'

test('a spawn is observed, not changed: its design and the finished agent\'s tokens reach the ledger', async ($, on) => {
  const agentLoop = { ...PHASES.loops[0]!, id: 'a1', type: 'Explore', model: 'claude-haiku-5-5', phase: 'analysis', runs: [{ phase: 'analysis', effort: 'low', steps: 3, errors: 1, since: 7 }] }
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w, { ...PHASES, loops: [...PHASES.loops, agentLoop] })
  const spawned = { model: 'claude-haiku-5-5', agentId: 'a1' }
  on('agent.spawn', () => spawned)
  let state: { delegations?: { total: number; designed: number; flags: Record<string, number> } } = {}
  on('state.set', ($, e, next) => {
    if ((e as { key?: string }).key === 'insights') state = (e as unknown as { value: typeof state }).value
    return next(e)
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  const result = await $.agent.spawn({ prompt: DESIGNED } as never)
  expect(result).toEqual(spawned)
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  const usage = { model: 'claude-haiku-5-5', input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }
  await $.turn.complete({ turnId: 'g1', reason: 'answer', agentId: 'a1', usage } as never)
  const ledger = w.store['turns:sess-1'] as { agents: unknown[] }[]
  expect(ledger[0]?.agents).toEqual([
    {
      agentId: 'a1',
      type: 'Explore',
      phase: 'analysis',
      model: 'claude-haiku-5-5',
      steps: 3,
      errors: 1,
      design: { model: 'opus', effort: 'high', shape: 'operational-definition → einstein: measure it' },
      tokensIn: 115,
      tokensOut: 7,
    },
  ])
  expect(state.delegations?.total).toBe(1)
  expect(state.delegations?.designed).toBe(1)
  expect(state.delegations?.flags.rerouted).toBe(1)
})

test('a spawn without a DESIGN block is undesigned; an agent whose spawn was never seen keeps no design field', async ($, on) => {
  const loop = (id: string) => ({ ...PHASES.loops[0]!, id, type: 'Explore', model: 'claude-sonnet-5-5', phase: 'analysis', runs: [{ phase: 'analysis', effort: 'low', steps: 9, errors: 0, since: 7 }] })
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w, { ...PHASES, loops: [...PHASES.loops, loop('b1'), loop('b2')] })
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'b1' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.agent.spawn({ prompt: 'just do it' } as never)
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  await $.turn.complete({ turnId: 'g1', reason: 'answer', agentId: 'b1' } as never)
  await $.turn.complete({ turnId: 'g2', reason: 'answer', agentId: 'b2' } as never)
  const agents = (w.store['turns:sess-1'] as { agents: { design?: unknown; tokensIn?: number }[] }[])[0]!.agents
  expect(agents[0]?.design).toBeNull()
  expect('design' in agents[1]!).toBe(false)
  expect('tokensIn' in agents[1]!).toBe(false)
})

test('a resumed agent: the design outlives its first turn, each record keeps its own turn\'s steps, one delegation', async ($, on) => {
  const loop = (steps: number) => ({ ...PHASES.loops[0]!, id: 'r1', type: 'Explore', model: 'claude-opus-5-5', phase: 'analysis', runs: [{ phase: 'analysis', effort: 'low', steps, errors: 0, since: 7 }] })
  const w: World = { files: {}, written: {}, store: {} }
  let cumulative = 3
  stubs(on, w, { ...PHASES, get loops() { return [...PHASES.loops, loop(cumulative)] } })
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'r1' }))
  let state: { delegations?: { total: number }; agents?: { steps: number }[] } = {}
  on('state.set', ($, e, next) => {
    if ((e as { key?: string }).key === 'insights') state = (e as unknown as { value: typeof state }).value
    return next(e)
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.agent.spawn({ prompt: DESIGNED } as never)
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  await $.turn.complete({ turnId: 'g1', reason: 'answer', agentId: 'r1' } as never)
  cumulative = 5
  await $.turn.complete({ turnId: 'g2', reason: 'answer', agentId: 'r1' } as never)
  const agents = (w.store['turns:sess-1'] as { agents: { agentId?: string; steps: number; design?: unknown }[] }[])[0]!.agents
  expect(agents.map((a) => a.agentId)).toEqual(['r1', 'r1'])
  expect(agents.map((a) => a.design !== undefined && a.design !== null)).toEqual([true, true])
  expect(agents.map((a) => a.steps)).toEqual([3, 2])
  expect(state.delegations?.total).toBe(1)
  expect(state.agents?.[0]?.steps).toBe(5)
})

test('a resumed agent whose row was evicted and reopened: the restarted row counts all its steps', async ($, on) => {
  const row = (since: number, steps: number) => ({ ...PHASES.loops[0]!, id: 'r1', type: 'Explore', model: 'claude-opus-5-5', phase: 'analysis', runs: [{ phase: 'analysis', effort: 'low', steps, errors: 0, since }] })
  const w: World = { files: {}, written: {}, store: {} }
  let current = row(10, 3)
  stubs(on, w, { ...PHASES, get loops() { return [...PHASES.loops, current] } })
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'r1' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.agent.spawn({ prompt: DESIGNED } as never)
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  await $.turn.complete({ turnId: 'g1', reason: 'answer', agentId: 'r1' } as never)
  current = row(500, 2)
  await $.turn.complete({ turnId: 'g2', reason: 'answer', agentId: 'r1' } as never)
  const agents = (w.store['turns:sess-1'] as { agents: { agentId?: string; steps: number }[] }[])[0]!.agents
  expect(agents.map((a) => a.agentId)).toEqual(['r1', 'r1'])
  expect(agents.map((a) => a.steps)).toEqual([3, 2])
})

// The self-calibration section: frozen at session start, appended last, never doubled.
const ENGINE = { sections: [{ id: 'intro', text: 'x', scope: 'shared' as const }] }
const BRIEF_ID = 'zetetic-insights:self-calibration'
const past = (i: number) => ({
  session: 'old',
  turnId: `p-${i}`,
  at: i,
  taskClass: null,
  mainModel: 'claude-opus-5-5',
  main: [{ phase: 'analysis', effort: 'medium', steps: 3, errors: 0, reads: 3 }],
  agents: [],
  advisor: { calls: 0, beforeWrite: 0, atCompletion: 0 },
  stuck: 0,
})
const compose = ($: Parameters<TestBody>[0]) =>
  $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)

test('prompt.compose: the brief is appended last, on the session side, and the engine sections are kept', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { turns: [past(1), past(2)] } }
  stubs(on, w)
  on('prompt.compose', () => ENGINE)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  const r = await compose($)
  expect(r.sections.length).toBe(2)
  expect(r.sections[0]).toEqual(ENGINE.sections[0])
  const last = r.sections[1]!
  expect(last.id).toBe(BRIEF_ID)
  expect(last.scope).toBe('session')
  expect(last.text).toBe(
    [
      'Self-calibration (zetetic-insights ledger, last 1 sessions). Measured, not prescribed:',
      '- main thread on opus/fable: 100% of its measured steps only read files (Read, Grep, Glob); those reads need no heavy model.',
      '- steps by model: opus 100%.',
    ].join('\n'),
  )
})

test('prompt.compose: the text stays the same after a turn changed the ledger, and is never doubled', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { turns: [past(1), past(2)] } }
  stubs(on, w)
  let engine: { sections: { id: string; text: string; scope: 'shared' | 'session' }[] } = ENGINE
  on('prompt.compose', () => engine)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  const first = (await compose($)).sections[1]!.text
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  expect((w.store['legacy:old'] as unknown[]).length + (w.store['turns:sess-1'] as unknown[]).length).toBe(3)
  const second = await compose($)
  expect(second.sections.length).toBe(2)
  expect(second.sections[1]!.text).toBe(first)
  // Composed over a list that already holds the id: replaced, not added twice.
  engine = { sections: [...ENGINE.sections, { id: BRIEF_ID, text: 'stale', scope: 'session' }] }
  const again = await compose($)
  expect(again.sections.filter((s) => s.id === BRIEF_ID).length).toBe(1)
  expect(again.sections[again.sections.length - 1]!.text).toBe(first)
})

test('prompt.compose: an empty ledger adds no section', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w)
  on('prompt.compose', () => ENGINE)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  expect(await compose($)).toEqual(ENGINE)
})

// The handoff to Cortex: each finished session, once, from a later start, never inside a hook.
const SERVER = 'plugin_hypermnesia-mcp_cortex'
type Call = { server: string; tool: string; args: Record<string, unknown> }
// reply: isError, or the structured dict Cortex returns (shapes from remember_response.py 69-123,
// remember_helpers.py 821-873, write_gate.py 145-166); by default a new stored or superseded row.
type Reply = { isError: boolean; structured?: Record<string, unknown> }
const cortex = (on: Parameters<TestBody>[1], reply: Reply = { isError: false }) => {
  const calls: Call[] = []
  const answer = { reply }
  on('mcp.call', ($, e, next) => {
    const { server, tool, args } = e as unknown as Call
    if (server !== SERVER) return next(e)
    calls.push({ server, tool, args })
    if (answer.reply.isError) return { value: { content: [{ type: 'text' as const, text: 'down' }], isError: true } }
    const structured = answer.reply.structured ?? { stored: true, memory_id: 100 + calls.length, action: 'supersedes_id' in args ? 'superseded' : 'stored', reason: 'novel' }
    return { value: { content: [{ type: 'text' as const, text: JSON.stringify(structured) }], isError: false, structuredContent: structured } }
  })
  return { calls, answer }
}
const watch = (on: Parameters<TestBody>[1]) => {
  const seen: { cortex?: { pushed: number; pending: number; lastError: string | null; lastAt: number | null } } = {}
  on('state.set', ($, e, next) => {
    if ((e as { key?: string }).key === 'insights') seen.cortex = (e as unknown as { value: typeof seen }).value.cortex
    return next(e)
  })
  return seen
}
// Two past sessions (old-a older than old-b) and the current one, sess-1, already in the ledger.
const pastSession = (session: string, at: number) => ({ ...past(at), session, turnId: `${session}-t` })
const LEDGER = () => [pastSession('old-b', 20), pastSession('old-a', 10), pastSession('sess-1', 30)]
// The two past sessions' processes ended them (session.end wrote ended:); sess-1 is this one, live.
const ENDED_PAST = { 'ended:old-a': { at: 11 }, 'ended:old-b': { at: 21 } }
const pushedKeys = (store: Record<string, unknown>) => Object.keys(store).filter((k) => k.startsWith('pushed:')).sort()
const START = { surface: 'terminal', isInteractive: true, cwd: '/r' } as const

test('cortex: after start one aggregate over the 2 past sessions is remembered, the current one is not', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { turns: LEDGER(), ...ENDED_PAST } }
  const clock = stubs(on, w)
  const { calls } = cortex(on)
  const seen = watch(on)
  await $.session.start(START)
  expect(calls.length).toBe(0)
  expect(seen.cortex).toEqual({ pushed: 0, pending: 2, lastError: null, lastAt: null })
  await clock.advance(60_000)
  expect(calls.map((c) => c.tool)).toEqual(['remember'])
  expect(String(calls[0]?.args.content).split('\n')[0]).toBe('Self-calibration (zetetic-insights, last 2 finished sessions, as of 1970-01-01):')
  expect(Object.keys(calls[0]?.args ?? {}).sort()).toEqual(['agent_topic', 'content', 'origin_tool', 'source', 'tags', 'write_class'])
  expect(w.store.aggregate).toEqual({ at: 31_000, memoryId: 101 })
  expect(calls[0]?.args).toMatchObject({ tags: ['archival', 'self-calibration', 'zetetic-insights'], agent_topic: 'self-calibration', source: 'tool', origin_tool: 'zetetic-insights', write_class: 'deliberate' })
  expect(pushedKeys(w.store)).toEqual(['pushed:old-a', 'pushed:old-b'])
  expect(seen.cortex).toMatchObject({ pushed: 2, pending: 0, lastError: null })
})

test('cortex: a second start remembers nothing more', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { turns: LEDGER(), ...ENDED_PAST } }
  const clock = stubs(on, w)
  const { calls } = cortex(on)
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.length).toBe(1)
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.length).toBe(1)
})

test('cortex: an isError reply stops the batch, is named in the state, and the next start retries', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { turns: LEDGER(), ...ENDED_PAST } }
  const clock = stubs(on, w)
  const { calls, answer } = cortex(on, { isError: true })
  const seen = watch(on)
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.length).toBe(1)
  expect(pushedKeys(w.store)).toEqual([])
  expect(seen.cortex?.pushed).toBe(0)
  expect(seen.cortex?.pending).toBe(2)
  expect(seen.cortex?.lastError).toMatch(/down/)
  answer.reply = { isError: false }
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.length).toBe(2)
  expect(pushedKeys(w.store)).toEqual(['pushed:old-a', 'pushed:old-b'])
  expect(seen.cortex).toMatchObject({ pushed: 2, pending: 0 })
})

test('cortex: a state stored by an older version, without pushed, reads as empty', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { turns: LEDGER(), pushed: 'garbage', ...ENDED_PAST } }
  const clock = stubs(on, w)
  const { calls } = cortex(on)
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.length).toBe(1)
})

test('cortex: no mcp.call happens inside a session.end hook', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { turns: LEDGER(), ...ENDED_PAST } }
  stubs(on, w)
  const { calls } = cortex(on)
  on('session.end', () => ({ sessionId: 'sess-1' }))
  await $.session.start(START)
  await $.session.end({ reason: 'exit', sessionId: 'sess-1' } as never)
  expect(calls.length).toBe(0)
})

// Two Claude processes, one store. This process is A (session sess-1); B is a second process whose
// writes land in the shared store between A's own (the kit hosts one plugin instance).
const recordsOf = (store: Record<string, unknown>) =>
  Object.entries(store)
    .filter(([k]) => k === 'turns' || k.startsWith('turns:'))
    .flatMap(([, v]) => v as { turnId: string }[])
const turnIds = (store: Record<string, unknown>) => [...new Set(recordsOf(store).map((r) => r.turnId))].sort()
const PHASES_AT = (turnId: string) => ({ ...PHASES, turnId })
const bTurn = (i: number) => ({ ...pastSession('B', 900 + i), turnId: `B-t${i}` })
const watchTurns = (on: Parameters<TestBody>[1]) => {
  const seen: { turns?: number } = {}
  on('state.set', ($, e, next) => {
    if ((e as { key?: string }).key === 'insights') seen.turns = (e as unknown as { value: { turns: number } }).value.turns
    return next(e)
  })
  return seen
}

// D1: B's records sit under the legacy key, the one the single-key ledger had every process rewrite
// whole: A's own writes must not erase them, and A's next start moves them to turns:B.
test('D1 two processes: A records 2 turns while B records 3 under the shared key: all 5 survive', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  let phases = PHASES_AT('A-t1')
  stubs(on, w, { get turnId() { return phases.turnId }, loops: PHASES.loops, advisor: PHASES.advisor })
  const seen = watchTurns(on)
  await $.session.start(START)
  w.store.turns = [bTurn(1)]
  await $.turn.complete({ turnId: 'A-t1', reason: 'answer' } as never)
  w.store.turns = [bTurn(1), bTurn(2)]
  phases = PHASES_AT('A-t2')
  await $.turn.complete({ turnId: 'A-t2', reason: 'answer' } as never)
  w.store.turns = [bTurn(1), bTurn(2), bTurn(3)]
  expect(turnIds(w.store)).toEqual(['A-t1', 'A-t2', 'B-t1', 'B-t2', 'B-t3'])
  await $.session.start(START)
  expect(seen.turns).toBe(5)
})

// I2 I1: B, a process of this version, writes its own key between A's turns; A never writes it.
test('I2 two processes: B writes turns:B between A\'s turns; A leaves it as B wrote it, and sees it at its next start', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w)
  const seen = watchTurns(on)
  await $.session.start(START)
  w.store['turns:B'] = [bTurn(1), bTurn(2), bTurn(3)]
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  expect(w.store['turns:B']).toEqual([bTurn(1), bTurn(2), bTurn(3)])
  expect(Object.keys(w.store).sort()).toEqual(['turns:B', 'turns:sess-1'])
  await $.session.start(START)
  expect(seen.turns).toBe(4)
})

// D2 and I3: B is live (fresh, no ended:) while A starts: A never hands it over. Its records sit
// under the legacy key so that the single-key version, which read only that key, sees them too.
test('D2 I3 a session live in another process is not handed over; after its ended:, it is, exactly once', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { turns: [bTurn(1)] } }
  const clock = stubs(on, w)
  const { calls } = cortex(on)
  const seen = watch(on)
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.length).toBe(0)
  expect(seen.cortex).toMatchObject({ pending: 0, lastError: null })
  w.store['ended:B'] = { at: 2_000 } // B's process ended it
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.map((c) => String(c.args.content).slice(0, 49))).toEqual(['Self-calibration (zetetic-insights, last 1 finish'])
  expect(w.store['pushed:B']).toBeDefined()
  expect((w.store['claim:aggregate'] as { by: string }).by).toBe('sess-1')
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.length).toBe(1)
})

test('I3 a claim by another process younger than the TTL makes A skip; one taken during the delay too; an expired one does not', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { 'turns:B': [bTurn(1)], 'ended:B': { at: 950 }, 'claim:aggregate': { by: 'C', at: 900 } } }
  const clock = stubs(on, w)
  const { calls } = cortex(on)
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.length).toBe(0)
  // The claim expires (TTL 10 min): the next start schedules B, but C claims it again during the delay.
  await clock.advance(10 * 60_000)
  await $.session.start(START)
  w.store['claim:aggregate'] = { by: 'C', at: clock.now() }
  await clock.advance(60_000)
  expect(calls.length).toBe(0)
  expect(w.store['pushed:B']).toBeUndefined()
  // C died mid-handover: once its claim is older than the TTL, A hands B over.
  await clock.advance(10 * 60_000)
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.length).toBe(1)
})

test('I3 a crashed session (no ended:, no turn for 24 h) is finished: handed over', async ($, on) => {
  const DAY = 24 * 3_600_000
  const w: World = { files: {}, written: {}, store: { 'turns:B': [{ ...bTurn(1), at: 5_000 }] } }
  const clock = stubs(on, w, PHASES, 5_000 + DAY - 1)
  const { calls } = cortex(on)
  await $.session.start(START)
  await clock.advance(1)
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.length).toBe(1)
})

test('I3 session.end marks the own session ended (also on /clear, old id), never one without records', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w)
  on('session.end', ($, e) => ({ sessionId: (e as { sessionId: string }).sessionId }))
  await $.session.start(START)
  await $.session.end({ reason: 'clear', sessionId: 'sess-1' } as never)
  expect(w.store['ended:sess-1']).toBeUndefined()
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  await $.session.end({ reason: 'clear', sessionId: 'sess-1' } as never)
  expect(w.store['ended:sess-1']).toEqual({ at: 1_000 })
  // /clear goes on under a new id: its start keeps the old session's keys, now another's.
  w.sid = 'sess-2'
  await $.session.start(START)
  expect(w.store['turns:sess-1']).toBeDefined()
  expect(w.store['ended:sess-1']).toEqual({ at: 1_000 })
})

test('I3 a resumed session is live again: its start removes its own ended:', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { 'turns:sess-1': [{ ...bTurn(1), session: 'sess-1' }], 'ended:sess-1': { at: 950 } } }
  stubs(on, w)
  await $.session.start(START)
  expect(w.store['ended:sess-1']).toBeUndefined()
  expect((w.store['turns:sess-1'] as unknown[]).length).toBe(1)
})

test('I5 migration from the legacy turns and pushed keys, run twice: the same store', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { turns: LEDGER(), pushed: ['old-a', 'never-recorded'] } }
  stubs(on, w)
  await $.session.start(START)
  const once = JSON.parse(JSON.stringify(w.store))
  expect(Object.keys(once).sort()).toEqual(['legacy:old-a', 'legacy:old-b', 'legacy:sess-1', 'pushed:old-a'])
  expect(once['legacy:old-b']).toEqual([pastSession('old-b', 20)])
  await $.session.start(START)
  expect(w.store).toEqual(once)
})

test('I1 an orphan claim:, pushed: or ended: (its turns: evicted by another process) goes at the next own write', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { 'claim:gone': { by: 'C', at: 1 }, 'pushed:gone': { at: 1 }, 'turns:B': [bTurn(1)], 'claim:B': { by: 'C', at: 999 } } }
  stubs(on, w)
  await $.session.start(START)
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  expect(Object.keys(w.store).sort()).toEqual(['claim:B', 'turns:B', 'turns:sess-1'])
})

test('a turn before any start (a hot reload resets the module) reads the own key first, never erasing it', async ($, on) => {
  const mine = { ...bTurn(1), session: 'sess-1', turnId: 'before' }
  const w: World = { files: {}, written: {}, store: { 'turns:sess-1': [mine] } }
  stubs(on, w)
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  expect((w.store['turns:sess-1'] as { turnId: string }[]).map((r) => r.turnId)).toEqual(['before', 't1'])
})

test('schedulePush: a session id that throws is named in state.cortex and start() completes', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  w.sidDenied = 'no id'
  stubs(on, w)
  const seen = watch(on)
  await $.session.start(START)
  // start() completed: the hook went on to register /calibrate, whose command now runs.
  expect((await $.command.run({ command: 'calibrate' } as never)).text).toMatch(/^Ledger: 0 turns/)
  expect(seen.cortex?.lastError).toMatch(/handover not scheduled: .*no id/)
})

test('the clock.after callback leaves no rejection unhandled when the state itself refuses', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { turns: LEDGER(), ...ENDED_PAST } }
  const clock = stubs(on, w)
  const { calls } = cortex(on)
  let refuse = false
  on('state.set', ($, e, next) => (refuse ? { deny: 'state refused' } : next(e)))
  await $.session.start(START)
  refuse = true
  await clock.advance(60_000)
  expect(calls.length).toBe(1)
  expect(pushedKeys(w.store)).toEqual(['pushed:old-a', 'pushed:old-b'])
})

test('I3 a claim C writes between A\'s claim and A\'s read-back wins: A does not remember', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { 'turns:B': [bTurn(1)], 'ended:B': { at: 950 } } }
  w.afterSet = (key) => {
    if (key === 'claim:aggregate') w.store['claim:aggregate'] = { by: 'C', at: 1_000 }
  }
  const clock = stubs(on, w)
  const { calls } = cortex(on)
  const seen = watch(on)
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.length).toBe(0)
  expect(w.store['pushed:B']).toBeUndefined()
  expect(seen.cortex).toMatchObject({ pushed: 0, pending: 1, lastError: null })
})

test('I3 a session resumed during the delay (its process removed its ended:) is live again: not handed over', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { 'turns:B': [bTurn(1)], 'ended:B': { at: 950 } } }
  const clock = stubs(on, w)
  const { calls } = cortex(on)
  await $.session.start(START)
  delete w.store['ended:B']
  await clock.advance(60_000)
  expect(calls.length).toBe(0)
  expect(w.store['pushed:B']).toBeUndefined()
})

test('I3 two processes through claim:aggregate: the claim is set at selection; B2 overwrites it during the delay, so only B2 may remember', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { 'turns:B': [bTurn(1)], 'ended:B': { at: 950 } } }
  const clock = stubs(on, w)
  const { calls } = cortex(on)
  await $.session.start(START)
  expect(w.store['claim:aggregate']).toEqual({ by: 'sess-1', at: 1_000 })
  await clock.advance(10_000)
  w.store['claim:aggregate'] = { by: 'B2', at: clock.now() } // another process, its claim landing 10 s after A's
  await clock.advance(50_000)
  expect(calls.length).toBe(0)
  expect(w.store['pushed:B']).toBeUndefined()
})

const ARGS = ['agent_topic', 'content', 'origin_tool', 'source', 'tags', 'write_class']
test('the first aggregate is stored; a session resumed after it makes the next one supersede it, with the exact args', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { 'turns:B': [bTurn(1)], 'ended:B': { at: 950 } } }
  const clock = stubs(on, w)
  const { calls } = cortex(on)
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.length).toBe(1)
  expect(Object.keys(calls[0]?.args ?? {}).sort()).toEqual(ARGS)
  expect(calls[0]?.args).toEqual({ content: calls[0]?.args.content, tags: ['archival', 'self-calibration', 'zetetic-insights'], agent_topic: 'self-calibration', source: 'tool', origin_tool: 'zetetic-insights', write_class: 'deliberate' })
  expect(w.store['pushed:B']).toEqual({ at: 31_000, lastAt: 901 })
  expect(w.store.aggregate).toEqual({ at: 31_000, memoryId: 101 })
  // B's process resumes it (its start drops ended:B), records a turn, and ends it again.
  delete w.store['ended:B']
  w.store['turns:B'] = [bTurn(1), { ...bTurn(2), at: 40_000 }]
  w.store['ended:B'] = { at: 41_000 }
  await clock.advance(10 * 60_000)
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.length).toBe(2)
  expect(Object.keys(calls[1]?.args ?? {}).sort()).toEqual([...ARGS, 'supersedes_id'].sort())
  expect(calls[1]?.args.supersedes_id).toBe(101)
  expect(w.store['pushed:B']).toEqual({ at: 691_000, lastAt: 40_000 })
  expect(w.store.aggregate).toEqual({ at: 691_000, memoryId: 102 })
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.length).toBe(2)
})

// One finished session B, a head 50 known; the reply under test, then what the store and state hold.
const replied = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], structured: Record<string, unknown>) => {
  const w: World = { files: {}, written: {}, store: { 'turns:B': [bTurn(1)], 'ended:B': { at: 950 }, aggregate: { at: 1, memoryId: 50 } } }
  const clock = stubs(on, w)
  const { calls } = cortex(on, { isError: false, structured })
  const seen = watch(on)
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.length).toBe(1)
  expect(calls[0]?.args.supersedes_id).toBe(50)
  cortexCalls = { calls }
  advance = (ms: number) => clock.advance(ms)
  return { w, seen }
}
let cortexCalls: { calls: Call[] } = { calls: [] }
let advance: (ms: number) => Promise<unknown> = async () => undefined

test('a merged reply (another memory) records nothing and is named with its id', async ($, on) => {
  const { w, seen } = await replied($, on, { stored: true, memory_id: 7, action: 'merged', reason: 'merged_with_existing' })
  expect(w.store.aggregate).toEqual({ at: 1, memoryId: 50 })
  expect(w.store['pushed:B']).toBeUndefined()
  expect(seen.cortex).toMatchObject({ pushed: 0, pending: 1 })
  expect(seen.cortex?.lastError).toMatch(/merged .*memory 7/)
})

// Cortex core/write_gate.py build_rejection_response: stored false, action rejected, reason, novelty, importance.
test('a write-gate rejection is not stored: head unchanged, nothing covered, named, sent again at the next start', async ($, on) => {
  const novelty = { embedding: 0.1, entity: 0.1, temporal: 0.1, structural: 0.1, score: 0.1 }
  const { w, seen } = await replied($, on, { stored: false, action: 'rejected', reason: 'low_novelty', novelty, importance: 0.2 })
  expect(w.store.aggregate).toEqual({ at: 1, memoryId: 50 })
  expect(Object.keys(w.store).some((k) => k.startsWith('pushed:'))).toBe(false)
  expect(seen.cortex).toMatchObject({ pushed: 0, pending: 1 })
  expect(seen.cortex?.lastError).toMatch(/low_novelty/)
  const { calls } = cortexCalls
  await $.session.start(START)
  await advance(10 * 60_000)
  expect(calls.length).toBe(2)
})

test('supersede_target_not_found clears the head; the sessions stay uncovered', async ($, on) => {
  const { w } = await replied($, on, { stored: false, action: 'rejected', reason: 'supersede_target_not_found', supersede_target_id: 50 })
  expect(w.store.aggregate).toEqual({ at: 31_000 })
  expect(w.store['pushed:B']).toBeUndefined()
})

test('supersede_target_already_superseded clears the head, never adopts the foreign id; the next remember has no supersedes_id', async ($, on) => {
  const { w, seen } = await replied($, on, { stored: false, action: 'rejected', reason: 'supersede_target_already_superseded', supersede_target_id: 50, current_superseded_by_id: 60 })
  expect(w.store.aggregate).toEqual({ at: 31_000 })
  expect(w.store['pushed:B']).toBeUndefined()
  expect(seen.cortex?.lastError).toMatch(/supersede_target_already_superseded.*60/)
  await $.session.start(START)
  await advance(10 * 60_000)
  expect(cortexCalls.calls.length).toBe(2)
  expect('supersedes_id' in (cortexCalls.calls[1]?.args ?? {})).toBe(false)
})

test('superseded_conflict clears the head, never adopts current_head_id; the next remember has no supersedes_id', async ($, on) => {
  const { w, seen } = await replied($, on, { stored: false, action: 'superseded_conflict', reason: 'supersede_chain_head_moving', supersede_target_id: 50, current_head_id: 61 })
  expect(w.store.aggregate).toEqual({ at: 31_000 })
  expect(w.store['pushed:B']).toBeUndefined()
  expect(seen.cortex?.lastError).toMatch(/supersede_chain_head_moving.*61/)
  await $.session.start(START)
  await advance(10 * 60_000)
  expect(cortexCalls.calls.length).toBe(2)
  expect('supersedes_id' in (cortexCalls.calls[1]?.args ?? {})).toBe(false)
})

test('a live session (no ended:, fresh) is not in the aggregate', async ($, on) => {
  const live = { ...pastSession('L', 990), turnId: 'L-t', mainModel: 'claude-haiku-5-5' }
  const w: World = { files: {}, written: {}, store: { 'turns:B': [bTurn(1)], 'ended:B': { at: 950 }, 'turns:L': [live] } }
  const clock = stubs(on, w)
  const { calls } = cortex(on)
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.length).toBe(1)
  expect(String(calls[0]?.args.content)).toMatch(/last 1 finished sessions/)
  expect(String(calls[0]?.args.content)).not.toMatch(/haiku/)
  expect(w.store['pushed:L']).toBeUndefined()
})

test('a legacy pushed list: the migrated pushed: covers every legacy record, nothing is sent again', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { turns: LEDGER(), pushed: ['old-a', 'old-b'], ...ENDED_PAST } }
  const clock = stubs(on, w)
  const { calls } = cortex(on)
  await $.session.start(START)
  expect(w.store['pushed:old-a']).toEqual({ at: 0, lastAt: 10 })
  await clock.advance(60_000)
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.length).toBe(0)
})

// F4: a pushed: without a numeric lastAt (the legacy {at: 0}, or junk) covers nothing: re-sent once, then covered.
test('F4 a legacy or malformed pushed: is re-sent once, then covered', async ($, on) => {
  const c1 = { ...pastSession('C', 902), turnId: 'C-t1' }
  const w: World = { files: {}, written: {}, store: { 'turns:B': [bTurn(1)], 'ended:B': { at: 950 }, 'pushed:B': { at: 0 }, 'turns:C': [c1], 'ended:C': { at: 950 }, 'pushed:C': 'junk' } }
  const clock = stubs(on, w)
  const { calls } = cortex(on)
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.length).toBe(1)
  expect(String(calls[0]?.args.content)).toMatch(/last 2 finished sessions/)
  expect(w.store['pushed:B']).toEqual({ at: 31_000, lastAt: 901 })
  expect(w.store['pushed:C']).toEqual({ at: 31_000, lastAt: 902 })
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.length).toBe(1)
})

// F3: the claims are re-read just before claiming, not taken from the start snapshot.
test('F3 a claim another process writes after the ledger snapshot, before claimBatch, is honoured', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { 'turns:B': [bTurn(1)], 'ended:B': { at: 950 } } }
  const clock = stubs(on, w)
  const { calls } = cortex(on)
  on('state.set', ($, e, next) => {
    if (w.store['claim:aggregate'] === undefined) w.store['claim:aggregate'] = { by: 'C', at: 1_000 } // lands after loadLedger read the store
    return next(e)
  })
  await $.session.start(START)
  expect(w.store['claim:aggregate']).toEqual({ by: 'C', at: 1_000 })
  await clock.advance(60_000)
  expect(calls.length).toBe(0)
  expect(w.store['pushed:B']).toBeUndefined()
})

// F2: another process deletes only a session that has ended:. ~16 KB per record() (measured).
const DAY = 24 * 3_600_000
const many = (session: string, n: number, from = 0) => Array.from({ length: n }, (_, i) => record(from + i, session))
test('F2 under pressure the ended+pushed go first, then the ended+unpushed; an idle live session (24 h, no ended:) never', async ($, on) => {
  const w: World = {
    files: {},
    written: {},
    store: { 'turns:P': many('P', 20), 'ended:P': { at: 30 }, 'pushed:P': { at: 40, lastAt: 19 }, 'turns:U': many('U', 20, 5_000), 'ended:U': { at: 5_100 }, 'turns:L': many('L', 180) },
  }
  stubs(on, w, PHASES, DAY + 10_000)
  await $.session.start(START)
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  expect(Object.keys(w.store).filter((k) => k.startsWith('turns:')).sort()).toEqual(['turns:L', 'turns:sess-1'])
  expect((w.store['turns:L'] as unknown[]).length).toBe(180)
})

test('F2 only live sessions over the budget: the own write is refused and named, the idle live one kept', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { 'turns:L': many('L', 200) } }
  stubs(on, w, PHASES, DAY + 10_000)
  const seen: { ledgerError?: string | null } = {}
  on('state.set', ($, e, next) => {
    if ((e as { key?: string }).key === 'insights') seen.ledgerError = (e as unknown as { value: { ledgerError: string | null } }).value.ledgerError
    return next(e)
  })
  await $.session.start(START)
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  expect((w.store['turns:L'] as unknown[]).length).toBe(200)
  expect(w.store['turns:sess-1']).toBeUndefined()
  expect(seen.ledgerError).toMatch(/^not saved: .*live sessions/)
})

// Frictions: read from a finished session's transcript, deferred, once, and surfaced when they recur.
// A transcript line of the real shape (a Stop hook that blocked), every value made up.
const BLOCK_LINE = JSON.stringify({ type: 'attachment', attachment: { type: 'hook_blocking_error', hookName: 'Stop', hookEvent: 'Stop', blockingError: { blockingError: 'Owned cleanup remains: [{"path": "/Users/a/s1"}]', command: 'gate' } } })
const BLOCK_SIGNATURE = 'Owned cleanup remains: [{<Q>: <Q>}]'
const TRANSCRIPT = `${BLOCK_LINE}\n${BLOCK_LINE}\nnot json\n`
const lastState = (on: Parameters<TestBody>[1]) => {
  const seen: { state?: { frictions: unknown[]; brief: string | null; ledgerError: string | null } } = {}
  on('state.set', ($, e, next) => {
    if ((e as { key?: string }).key === 'insights') seen.state = (e as unknown as { value: NonNullable<typeof seen.state> }).value
    return next(e)
  })
  return seen
}
// The reads of each file, counted where the engine asks for it.
const counted = (w: World): Record<string, number> => {
  const reads: Record<string, number> = {}
  w.files = new Proxy(w.files, {
    get: (target, key: string) => {
      reads[key] = (reads[key] ?? 0) + 1
      return target[key]
    },
  })
  return reads
}
const withTranscripts = (extra: Record<string, unknown> = {}) => ({
  turns: LEDGER(),
  'ended:old-a': { at: 11, transcript: '/t/a.jsonl' },
  'ended:old-b': { at: 21, transcript: '/t/b.jsonl' },
  ...extra,
})

test('frictions: classic.SessionEnd names the transcript in ended:, one value, in either order with session.end', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w)
  on('session.end', ($, e) => ({ sessionId: (e as { sessionId: string }).sessionId }))
  on('classic.SessionEnd', () => ({}) as never)
  await $.session.start(START)
  await $.classic.SessionEnd({ reason: 'other', session_id: 'sess-1', transcript_path: '/t/s1.jsonl' })
  expect(w.store['ended:sess-1']).toBeUndefined() // no record: never marked
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  // The engine's order: the SessionEnd settings hooks, then session.end, which keeps the transcript.
  await $.classic.SessionEnd({ reason: 'other', session_id: 'sess-1', transcript_path: '/t/s1.jsonl' })
  expect(w.store['ended:sess-1']).toEqual({ at: 1_000, transcript: '/t/s1.jsonl' })
  await $.session.end({ reason: 'other', sessionId: 'sess-1' } as never)
  expect(w.store['ended:sess-1']).toEqual({ at: 1_000, transcript: '/t/s1.jsonl' })
  // Reversed: session.end first writes { at }, classic.SessionEnd then sets the full value.
  delete w.store['ended:sess-1']
  await $.session.end({ reason: 'other', sessionId: 'sess-1' } as never)
  expect(w.store['ended:sess-1']).toEqual({ at: 1_000 })
  await $.classic.SessionEnd({ reason: 'other', session_id: 'sess-1', transcript_path: '/t/s1.jsonl' })
  expect(w.store['ended:sess-1']).toEqual({ at: 1_000, transcript: '/t/s1.jsonl' })
})

test('frictions: without classic hooks (managed settings) ended: stays { at }; an empty transcript path names none', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w)
  on('session.end', ($, e) => ({ sessionId: (e as { sessionId: string }).sessionId }))
  on('classic.SessionEnd', () => ({}) as never)
  await $.session.start(START)
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  await $.session.end({ reason: 'other', sessionId: 'sess-1' } as never)
  expect(w.store['ended:sess-1']).toEqual({ at: 1_000 })
  await $.classic.SessionEnd({ reason: 'other', session_id: 'sess-1', transcript_path: '' })
  expect(w.store['ended:sess-1']).toEqual({ at: 1_000 })
})

test('frictions: the deferred timer reads each finished transcript once, writes frictions:<sid>, and state.frictions holds what recurs over 2 sessions', async ($, on) => {
  const w: World = { files: { '/t/a.jsonl': TRANSCRIPT, '/t/b.jsonl': BLOCK_LINE }, written: {}, store: withTranscripts() }
  const reads = counted(w)
  const clock = stubs(on, w)
  cortex(on)
  const seen = lastState(on)
  await $.session.start(START)
  expect(reads['/t/a.jsonl']).toBeUndefined() // nothing is read inside start
  expect(w.store['frictions:old-a']).toBeUndefined()
  expect(seen.state?.frictions).toEqual([])
  await clock.advance(60_000)
  expect(reads['/t/a.jsonl']).toBe(1)
  expect(reads['/t/b.jsonl']).toBe(1)
  expect(w.store['frictions:old-a']).toEqual([{ kind: 'hook-block', signature: BLOCK_SIGNATURE, count: 2 }])
  expect(w.store['frictions:old-b']).toEqual([{ kind: 'hook-block', signature: BLOCK_SIGNATURE, count: 1 }])
  expect(seen.state?.frictions).toEqual([{ kind: 'hook-block', signature: BLOCK_SIGNATURE, sessions: 2, count: 3 }])
  // The next start does not read them again; its brief (frozen at that start) names the friction.
  await $.session.start(START)
  await clock.advance(60_000)
  expect(reads['/t/a.jsonl']).toBe(1)
  expect(reads['/t/b.jsonl']).toBe(1)
  expect(seen.state?.brief).toContain(`- recurring friction: ${BLOCK_SIGNATURE} (hook-block, 2 sessions, 3 times)`)
})

test('frictions: the aggregate sent to Cortex says the recurring friction, measured before it in the same timer', async ($, on) => {
  const w: World = { files: { '/t/a.jsonl': TRANSCRIPT, '/t/b.jsonl': BLOCK_LINE }, written: {}, store: withTranscripts() }
  const clock = stubs(on, w)
  const { calls } = cortex(on)
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.map((c) => c.tool)).toEqual(['remember'])
  expect(String(calls[0]?.args.content).split('\n').pop()).toBe(`- recurring friction: ${BLOCK_SIGNATURE} (hook-block, 2 sessions, 3 times)`)
})

test('frictions: a read that fails is named in the state, the session stays unmarked, and the next start reads it again', async ($, on) => {
  const w: World = { files: { '/t/a.jsonl': TRANSCRIPT, '/t/b.jsonl': BLOCK_LINE }, written: {}, store: withTranscripts(), readErrors: { '/t/b.jsonl': 'EIO transient' } }
  const clock = stubs(on, w)
  cortex(on)
  const seen = lastState(on)
  await $.session.start(START)
  await clock.advance(60_000)
  expect(w.store['frictions:old-a']).toBeDefined()
  expect(w.store['frictions:old-b']).toBeUndefined()
  expect(seen.state?.ledgerError).toMatch(/^frictions not measured, retried at the next start: old-b: .*EIO transient/)
  delete w.readErrors!['/t/b.jsonl']
  await $.session.start(START)
  await clock.advance(60_000)
  expect(w.store['frictions:old-b']).toEqual([{ kind: 'hook-block', signature: BLOCK_SIGNATURE, count: 1 }])
  expect(seen.state?.ledgerError).toBeNull()
})

test('frictions: a turn saved after a failed read does not erase its name from the state', async ($, on) => {
  const w: World = { files: { '/t/a.jsonl': TRANSCRIPT, '/t/b.jsonl': BLOCK_LINE }, written: {}, store: withTranscripts(), readErrors: { '/t/a.jsonl': 'EIO transient' } }
  const clock = stubs(on, w)
  cortex(on)
  const seen = lastState(on)
  await $.session.start(START)
  await clock.advance(60_000)
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  expect(seen.state?.ledgerError).toMatch(/^frictions not measured/)
})

test('frictions: at most FRICTION_BATCH transcripts per start, the newest sessions first', async ($, on) => {
  const store: Record<string, unknown> = { 'turns:sess-1': [{ ...pastSession('sess-1', 100) }] }
  const files: Record<string, string> = {}
  for (const [s, at] of [['s1', 10], ['s2', 20], ['s3', 30], ['s4', 40], ['s5', 50]] as const) {
    store[`turns:${s}`] = [pastSession(s, at)]
    store[`ended:${s}`] = { at: at + 1, transcript: `/t/${s}.jsonl` }
    files[`/t/${s}.jsonl`] = BLOCK_LINE
  }
  const w: World = { files, written: {}, store }
  const clock = stubs(on, w)
  cortex(on)
  await $.session.start(START)
  await clock.advance(60_000)
  const measured = () => Object.keys(w.store).filter((k) => k.startsWith('frictions:')).sort()
  expect(measured()).toEqual(['frictions:s3', 'frictions:s4', 'frictions:s5'])
  await $.session.start(START)
  await clock.advance(60_000)
  expect(measured()).toEqual(['frictions:s1', 'frictions:s2', 'frictions:s3', 'frictions:s4', 'frictions:s5'])
})

test('frictions: an ended: stored before the transcript was kept is not measurable: no read, no key, no crash, no friction', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { turns: LEDGER(), ...ENDED_PAST } }
  const reads = counted(w)
  const clock = stubs(on, w)
  cortex(on)
  const seen = lastState(on)
  await $.session.start(START)
  await clock.advance(60_000)
  expect(Object.keys(reads)).not.toContain('/t/a.jsonl')
  expect(Object.keys(w.store).filter((k) => k.startsWith('frictions:'))).toEqual([])
  expect(seen.state?.frictions).toEqual([])
  expect(seen.state?.ledgerError).toBeNull()
})

test('frictions: a session outside the brief window is not measured', async ($, on) => {
  const store: Record<string, unknown> = { 'turns:sess-1': [pastSession('sess-1', 1000)] }
  for (let i = 1; i <= 11; i++) {
    store[`turns:s${i}`] = [pastSession(`s${i}`, 10 * i)]
    store[`ended:s${i}`] = { at: 10 * i, transcript: `/t/s${i}.jsonl` }
  }
  const files = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`/t/s${i + 1}.jsonl`, BLOCK_LINE]))
  const w: World = { files, written: {}, store }
  const reads = counted(w)
  const clock = stubs(on, w)
  cortex(on)
  await $.session.start(START)
  await clock.advance(60_000)
  // The window is the 10 newest sessions of 12: sess-1 and s11..s3; s1 and s2 are outside.
  expect(Object.keys(reads).filter((k) => k.endsWith('.jsonl')).sort()).toEqual(['/t/s11.jsonl', '/t/s10.jsonl', '/t/s9.jsonl'].sort())
  expect(w.store['frictions:s1']).toBeUndefined()
})

test('frictions: frictions:<s> goes with its session on eviction and as an orphan, and with the own ended: on resume', async ($, on) => {
  const w: World = {
    files: {},
    written: {},
    store: { 'turns:P': many('P', 20), 'ended:P': { at: 30, transcript: '/t/p' }, 'pushed:P': { at: 40, lastAt: 19 }, 'frictions:P': [], 'turns:L': many('L', 180), 'frictions:gone': [], 'ended:sess-1': { at: 1, transcript: '/t/own' }, 'frictions:sess-1': [] },
  }
  stubs(on, w, PHASES, DAY + 10_000)
  await $.session.start(START)
  expect(w.store['ended:sess-1']).toBeUndefined() // resumed: live again
  expect(w.store['frictions:sess-1']).toBeUndefined() // its transcript grows: measured afresh at its end
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  expect(Object.keys(w.store).filter((k) => k.includes(':P') || k === 'frictions:gone')).toEqual([])
  expect(w.store['turns:L']).toBeDefined()
})

test('frictions: a transcript that no longer exists is marked missing once, never read again, and counts as measured with no rows', async ($, on) => {
  const w: World = { files: { '/t/a.jsonl': TRANSCRIPT }, written: {}, store: withTranscripts() }
  const reads = counted(w)
  const clock = stubs(on, w)
  cortex(on)
  const seen = lastState(on)
  await $.session.start(START)
  await clock.advance(60_000)
  expect(w.store['frictions:old-b']).toEqual({ unavailable: 'missing' })
  expect(Object.keys(reads)).not.toContain('/t/b.jsonl')
  expect(seen.state?.ledgerError).toBeNull()
  // The marker is final: even if the file appears, the next start does not look at it.
  w.files['/t/b.jsonl'] = BLOCK_LINE
  await $.session.start(START)
  await clock.advance(60_000)
  expect(Object.keys(reads)).not.toContain('/t/b.jsonl')
  expect(w.store['frictions:old-b']).toEqual({ unavailable: 'missing' })
  expect(seen.state?.frictions).toEqual([]) // one session with rows is not a recurrence
})

test('frictions: a transcript over FRICTION_MAX_BYTES is not read, is marked too-large and named', async ($, on) => {
  const w: World = { files: { '/t/a.jsonl': TRANSCRIPT, '/t/b.jsonl': BLOCK_LINE }, written: {}, store: withTranscripts(), sizes: { '/t/b.jsonl': FRICTION_MAX_BYTES + 1 } }
  const reads = counted(w)
  const clock = stubs(on, w)
  cortex(on)
  const seen = lastState(on)
  await $.session.start(START)
  await clock.advance(60_000)
  expect(w.store['frictions:old-b']).toEqual({ unavailable: 'too-large' })
  expect(Object.keys(reads)).not.toContain('/t/b.jsonl')
  expect(w.store['frictions:old-a']).toBeDefined()
  expect(seen.state?.ledgerError).toMatch(/^frictions not measured, transcript over 20971520 bytes: old-b 20971521 bytes/)
  w.sizes = { '/t/b.jsonl': FRICTION_MAX_BYTES } // exactly the cap is read
  delete w.store['frictions:old-b']
  await $.session.start(START)
  await clock.advance(60_000)
  expect(w.store['frictions:old-b']).toEqual([{ kind: 'hook-block', signature: BLOCK_SIGNATURE, count: 1 }])
})
