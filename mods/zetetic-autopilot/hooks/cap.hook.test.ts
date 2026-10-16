import { expect, test } from 'claude-code/testing'

import { ENFORCE, ENGINEER, QUOTA, type Body, done, freshSeen, spawn, stubs, used } from './harness'

// Owner rule, 2026-10-15: the quota limits how many subagents run at once. The cap is a function of the
// five-hour window (concurrency.ts); a spawn past it is refused with a message the orchestrator reads, and a
// finished agent frees its place. Event-based: spawn adds an agent, its turn.complete removes it.

const scenario = (name: string, options: Record<string, string | number>, body: Body) =>
  test(name, { options }, async ($, on) => {
    const seen = freshSeen()
    stubs(on, seen)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
    await body($, seen)
  })

// A spawn's outcome as the Agent tool call sees it: the started agent, or the refusal.
const tryAgent = async ($: Parameters<Body>[0], model = 'haiku') => $.agent.spawn(spawn(ENGINEER, model))

// Live-probe (b): with the cap at 1 and one agent running, a second spawn is refused with the message.
scenario('at the quota mark the cap is 1: a second spawn is refused and the message names count, cap, quota and the way out', ENFORCE, async ($, seen) => {
  await $.session.measure(QUOTA)
  const first = await tryAgent($)
  const second = await tryAgent($)
  expect(first).toMatchObject({ agentId: 'ag-1' })
  expect(second.deny).toBe(
    'zetetic-autopilot: 1 subagent is running and the cap is 1 at 90% of the five-hour window (the cap falls from 5 to 1 as the window fills to 80%). Wait for a running agent to finish, then spawn this one again.',
  )
  expect(seen.sent).toEqual(['haiku']) // the second never reached the engine
  expect(seen.decisions.find((d) => d.kind === 'cap')).toMatchObject({ applied: true, from: '1 running', to: 'cap 1', subject: ENGINEER, reason: second.deny })
  expect(seen.toasts).toEqual([second.deny])
})

scenario('a finished agent frees its place: the next spawn passes', ENFORCE, async ($, seen) => {
  await $.session.measure(QUOTA)
  await tryAgent($)
  expect((await tryAgent($)).deny).toBeDefined()
  await $.turn.complete(done('ag-1'))
  expect(await tryAgent($)).toMatchObject({ agentId: 'ag-2' })
  expect(seen.sent).toEqual(['haiku', 'haiku'])
})

// The event alone frees the place: the engine's list is only the check before a refusal.
scenario('an agent whose turn.complete was seen frees its place, whatever the engine list still says', ENFORCE, async ($, seen) => {
  await $.session.measure(QUOTA)
  await tryAgent($)
  await $.turn.complete(done('ag-1'))
  seen.listed = [{ id: 'ag-1', status: 'running' }]
  expect(await tryAgent($)).toMatchObject({ agentId: 'ag-2' })
})

scenario('the cap follows the window: 5 at a free quota, 3 at 45%, and the sixth / fourth is refused', ENFORCE, async ($) => {
  const outcomes = async (n: number) => {
    const out: boolean[] = []
    for (let i = 0; i < n; i++) out.push((await tryAgent($)).deny === undefined)
    return out
  }
  expect(await outcomes(6)).toEqual([true, true, true, true, true, false])
  for (const id of ['ag-1', 'ag-2', 'ag-3', 'ag-4', 'ag-5']) await $.turn.complete(done(id))
  await $.session.measure(used(45))
  expect(await outcomes(4)).toEqual([true, true, true, false])
})

scenario('a window with no reading limits nothing below the maximum, and the maximum is an option', { ...ENFORCE, max_parallel_agents: 2 }, async ($) => {
  expect((await tryAgent($)).deny).toBeUndefined()
  expect((await tryAgent($)).deny).toBeUndefined()
  expect((await tryAgent($)).deny).toContain('cap is 2')
})

// A hook that checks and counts in separate steps lets two simultaneous spawns both pass a cap of one.
scenario('two spawns raised together under a cap of 1: exactly one passes', ENFORCE, async ($, seen) => {
  await $.session.measure(QUOTA)
  const both = await Promise.all([tryAgent($), tryAgent($)])
  expect(both.filter((r) => r.deny === undefined)).toHaveLength(1)
  expect(seen.sent).toEqual(['haiku'])
})

scenario('an agent the engine says is gone (killed, no turn.complete seen) does not hold its place', ENFORCE, async ($, seen) => {
  await $.session.measure(QUOTA)
  await tryAgent($)
  seen.listed = [{ id: 'ag-1', status: 'killed' }]
  expect(await tryAgent($)).toMatchObject({ agentId: 'ag-2' })
  seen.listed = [{ id: 'ag-1', status: 'killed' }, { id: 'ag-2', status: 'running' }]
  expect((await tryAgent($)).deny).toBeDefined()
})

scenario('the cap that cannot be checked admits the spawn and says so in a row', ENFORCE, async ($, seen) => {
  await $.session.measure(QUOTA)
  await tryAgent($)
  seen.listFails = true
  expect(await tryAgent($)).toMatchObject({ agentId: 'ag-2' })
  expect(seen.decisions.find((d) => d.kind === 'unread' && d.subject === 'agent cap')?.to).toMatch(/^not applied: /)
})

scenario('observe: the refusal is logged and not applied', { policy_mode: 'observe', quota_pressure_percent: 80 }, async ($, seen) => {
  await $.session.measure(QUOTA)
  await tryAgent($)
  expect(await tryAgent($)).toMatchObject({ agentId: 'ag-2' })
  expect(seen.decisions.find((d) => d.kind === 'cap')).toMatchObject({ applied: false })
  expect(seen.toasts).toEqual([])
})

scenario('a session start forgets the agents of the one before', ENFORCE, async ($) => {
  await $.session.measure(QUOTA)
  await tryAgent($)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  expect(await tryAgent($)).toMatchObject({ agentId: 'ag-2' })
})

// Owner rule: no task runs in the global session. Warn only; the call goes ahead.
const edit = { tool: 'Edit', file_path: '/r/src/a.ts', old_string: 'a', new_string: 'b' }

test('main writing code is a POLICY row each time and a toast once a turn; the call is not blocked', { options: ENFORCE }, async ($, on) => {
  const seen = freshSeen()
  stubs(on, seen)
  on('tool.call', () => ({ result: 'ok', text: 'ok' }) as never)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  const ran = await $.tool.call(edit as never)
  await $.tool.call(edit as never)
  expect((ran as { deny?: string }).deny).toBeUndefined()
  const rows = seen.decisions.filter((d) => d.kind === 'work')
  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({ subject: 'main · Edit', applied: false })
  expect(seen.toasts.filter((t) => t.includes('delegate'))).toHaveLength(1)
})

test('reading, checking and delegating are not warned about, nor is a subagent writing code', { options: ENFORCE }, async ($, on) => {
  const seen = freshSeen()
  stubs(on, seen)
  on('tool.call', () => ({ result: 'ok', text: 'ok' }) as never)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.tool.call({ tool: 'Read', file_path: '/r/a.ts' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git status' } as never)
  await $.tool.call({ ...edit, agentId: 'ag-9' } as never)
  expect(seen.decisions.filter((d) => d.kind === 'work')).toEqual([])
})

// m4: observe lets a would-be-refused spawn go ahead, so it is in flight like any other and holds its place
// until it answers; it must not give back a place it never took.
scenario('observe: a spawn let through over the cap is counted while in flight', { policy_mode: 'observe', quota_pressure_percent: 80 }, async ($, seen) => {
  await $.session.measure(QUOTA)
  await tryAgent($)
  await Promise.all([tryAgent($), tryAgent($)])
  expect(seen.decisions.filter((d) => d.kind === 'cap').map((d) => d.from)).toEqual(['1 running', '2 running'])
})

// m4: the engine refuses a max_parallel_agents that is not a number (userConfig type, the module does not load),
// but any number reaches the hook: 0 or a fraction is no count of agents. It falls back to the default, named.
for (const bad of [0, 2.5])
  scenario(`a max_parallel_agents of ${bad} is the default 5, named in a row`, { ...ENFORCE, max_parallel_agents: bad }, async ($, seen) => {
    const out: boolean[] = []
    for (let i = 0; i < 6; i++) out.push((await tryAgent($)).deny === undefined)
    expect(out).toEqual([true, true, true, true, true, false])
    expect(seen.decisions.find((d) => d.subject === 'agent cap option')?.to).toBe(`max_parallel_agents=${bad} is not a positive whole number; using 5`)
  })
