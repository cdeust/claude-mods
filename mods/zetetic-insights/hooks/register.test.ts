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

const stubs = (on: Parameters<TestBody>[1], w: World, phases: unknown = PHASES) => {
  const clock = mock.clock(on, { now: 1_000 })
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
  return clock
}

test('a run without reads is kept without them', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  const bare = { ...PHASES, loops: [{ ...PHASES.loops[0]!, runs: [{ phase: 'test', effort: 'medium', steps: 4, errors: 0, since: 5 }] }] }
  stubs(on, w, bare)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  expect((w.store.turns as { main: unknown[] }[])[0]?.main).toEqual([{ phase: 'test', effort: 'medium', steps: 4, errors: 0 }])
})

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
  const ledger = w.store.turns as { agents: unknown[] }[]
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
  const agents = (w.store.turns as { agents: { design?: unknown; tokensIn?: number }[] }[])[0]!.agents
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
  const agents = (w.store.turns as { agents: { agentId?: string; steps: number; design?: unknown }[] }[])[0]!.agents
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
  const agents = (w.store.turns as { agents: { agentId?: string; steps: number }[] }[])[0]!.agents
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
  expect((w.store.turns as unknown[]).length).toBe(3)
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
const cortex = (on: Parameters<TestBody>[1], reply: { isError: boolean } = { isError: false }) => {
  const calls: Call[] = []
  const answer = { reply }
  on('mcp.call', ($, e, next) => {
    const { server, tool, args } = e as unknown as Call
    if (server !== SERVER) return next(e)
    calls.push({ server, tool, args })
    return { value: { content: [{ type: 'text' as const, text: answer.reply.isError ? 'down' : '{"stored":true}' }], isError: answer.reply.isError } }
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
const START = { surface: 'terminal', isInteractive: true, cwd: '/r' } as const

test('cortex: after start the 2 past sessions are remembered, oldest first, the current one is not', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { turns: LEDGER() } }
  const clock = stubs(on, w)
  const { calls } = cortex(on)
  const seen = watch(on)
  await $.session.start(START)
  expect(calls.length).toBe(0)
  expect(seen.cortex).toEqual({ pushed: 0, pending: 2, lastError: null, lastAt: null })
  await clock.advance(60_000)
  expect(calls.map((c) => c.tool)).toEqual(['remember', 'remember'])
  expect(calls.map((c) => String(c.args.content).slice(0, 36))).toEqual(['Self-calibration of session old-a (1', 'Self-calibration of session old-b (1'])
  expect(Object.keys(calls[0]?.args ?? {}).sort()).toEqual(['agent_topic', 'content', 'origin_tool', 'source', 'tags'])
  expect(calls[0]?.args).toMatchObject({ tags: ['archival', 'self-calibration', 'zetetic-insights'], agent_topic: 'self-calibration', source: 'tool', origin_tool: 'zetetic-insights' })
  expect(w.store.pushed).toEqual(['old-a', 'old-b'])
  expect(seen.cortex).toMatchObject({ pushed: 2, pending: 0, lastError: null })
})

test('cortex: a second start remembers nothing more', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { turns: LEDGER() } }
  const clock = stubs(on, w)
  const { calls } = cortex(on)
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.length).toBe(2)
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.length).toBe(2)
})

test('cortex: an isError reply stops the batch, is named in the state, and the next start retries', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { turns: LEDGER() } }
  const clock = stubs(on, w)
  const { calls, answer } = cortex(on, { isError: true })
  const seen = watch(on)
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.length).toBe(1)
  expect(w.store.pushed ?? []).toEqual([])
  expect(seen.cortex?.pushed).toBe(0)
  expect(seen.cortex?.pending).toBe(2)
  expect(seen.cortex?.lastError).toMatch(/down/)
  answer.reply = { isError: false }
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.length).toBe(3)
  expect(w.store.pushed).toEqual(['old-a', 'old-b'])
  expect(seen.cortex).toMatchObject({ pushed: 2, pending: 0 })
})

test('cortex: a state stored by an older version, without pushed, reads as empty', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { turns: LEDGER(), pushed: 'garbage' } }
  const clock = stubs(on, w)
  const { calls } = cortex(on)
  await $.session.start(START)
  await clock.advance(60_000)
  expect(calls.length).toBe(2)
})

test('cortex: no mcp.call happens inside a session.end hook', async ($, on) => {
  const w: World = { files: {}, written: {}, store: { turns: LEDGER() } }
  stubs(on, w)
  const { calls } = cortex(on)
  on('session.end', () => ({ sessionId: 'sess-1' }))
  await $.session.start(START)
  await $.session.end({ reason: 'exit', sessionId: 'sess-1' } as never)
  expect(calls.length).toBe(0)
})
