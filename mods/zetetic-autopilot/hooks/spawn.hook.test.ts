import { expect, test } from 'claude-code/testing'

import { ARCHITECT, CONTEXT, ENFORCE, ENGINEER, QUOTA, type Body, done, freshSeen, spawn, stubs } from './harness'
import { ROUTES_PER_SESSION } from './spawns'

// The model a subagent runs on is the one the orchestrator designed: the Agent call's `model`, else
// the definition's. No pressure changes it (the quota limits how many run at once: cap.hook.test.ts),
// and each spawn keeps the route that decided.

const scenario = (name: string, options: Record<string, string | number>, body: Body) =>
  test(name, { options }, async ($, on) => {
    const seen = freshSeen()
    stubs(on, seen)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
    await body($, seen)
  })

scenario('(a) a call model opus beats a sonnet definition, with the orchestrator past the context mark', ENFORCE, async ($, seen) => {
  await $.session.measure(CONTEXT)
  await $.agent.spawn(spawn(ENGINEER, 'opus'))
  expect(seen.sent).toEqual(['opus'])
  expect(seen.spawns?.[0]).toMatchObject({ requested: 'opus', definition: 'sonnet', decided: 'opus', reason: 'call' })
})

scenario('(b) no call model: the definition decides, also with the orchestrator past the context mark', ENFORCE, async ($, seen) => {
  await $.session.measure(CONTEXT)
  await $.agent.spawn(spawn(ENGINEER))
  await $.agent.spawn(spawn(ARCHITECT))
  expect(seen.sent).toEqual([undefined, undefined])
  expect(seen.spawns?.[0]).toMatchObject({ requested: null, definition: 'sonnet', decided: 'sonnet', reason: 'definition' })
  expect(seen.spawns?.[1]).toMatchObject({ requested: null, definition: 'opus', decided: 'opus' })
})

// Owner rule 2026-10-15, live-probe (a): a call for opus under simulated quota pressure runs opus.
scenario('(c) quota pressure never changes a designed model: opus, haiku and sonnet calls and an opus definition stand', ENFORCE, async ($, seen) => {
  await $.session.measure(QUOTA)
  for (const [i, model] of ['opus', 'haiku', 'sonnet', undefined].entries()) {
    await $.agent.spawn(spawn(i === 3 ? ARCHITECT : ENGINEER, model))
    await $.turn.complete(done(`ag-${i + 1}`)) // one at a time: the cap at this quota is 1
  }
  expect(seen.sent).toEqual(['opus', 'haiku', 'sonnet', undefined])
  expect(seen.spawns?.map((r) => [r.decided, r.ran, r.reason, r.applied])).toEqual([
    ['opus', 'opus', 'call', false],
    ['haiku', 'haiku', 'call', false],
    ['sonnet', 'sonnet', 'call', false],
    ['opus', 'sonnet', 'definition', false],
  ])
  expect(seen.decisions.filter((d) => d.kind === 'model')).toEqual([])
})

scenario('(c) an inheriting type is routed by its kind, the same under quota pressure as without it', ENFORCE, async ($, seen) => {
  await $.agent.spawn(spawn('Explore'))
  await $.turn.complete(done('ag-1'))
  await $.session.measure(QUOTA)
  await $.agent.spawn(spawn('Explore'))
  expect(seen.sent).toEqual(['sonnet', 'sonnet'])
  expect(seen.spawns?.map((r) => r.reason)).toEqual(['kind', 'kind'])
})

scenario('(d) every spawn keeps requested, definition, decided, ran and a short reason in the state and in the store', ENFORCE, async ($, seen) => {
  await $.agent.spawn(spawn(ENGINEER, 'opus'))
  const kept = seen.store['spawns:0000001000000:sid-1']
  expect(kept?.[0]).toMatchObject({ agentId: 'ag-1', type: ENGINEER, requested: 'opus', definition: 'sonnet', decided: 'opus', ran: 'opus', reason: 'call', applied: false })
  expect(seen.spawns).toEqual(kept)
})

scenario('(d) past the hard bound the oldest session keys are deleted at the start, whatever their age', ENFORCE, async ($, seen) => {
  // The clock reads 1 000 000 ms: the 50 keys started at 0..49 ms are all younger than the TTL, so only the
  // hard bound deletes: 11 of them.
  for (let i = 0; i < 50; i++) seen.store[`spawns:${String(i).padStart(13, '0')}:old`] = []
  seen.store['turns:other'] = []
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  const keys = Object.keys(seen.store).filter((k) => k.startsWith('spawns:'))
  expect(keys).toHaveLength(39) // HARD_SESSIONS - 1: the key about to be written is the 40th
  expect(keys).not.toContain('spawns:0000000000000:old')
  expect(seen.store['turns:other']).toEqual([])
})

scenario('B1: a long-running session outside the newest KEEP_SESSIONS keeps its routes at the next session start', { ...ENFORCE, max_parallel_agents: 500 }, async ($, seen) => {
  // 25 newer sessions started after it, all within the TTL (the clock reads 1 000 000 ms).
  seen.store['spawns:0000000000500:long-running'] = [{ agentId: 'early' } as never]
  for (let i = 0; i < 25; i++) seen.store[`spawns:${String(600 + i).padStart(13, '0')}:n${i}`] = []
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  expect(seen.store['spawns:0000000000500:long-running']).toEqual([{ agentId: 'early' }])
})

const spawnMany = async ($: Parameters<Body>[0], n: number) => {
  for (let i = 0; i < n; i++) await $.agent.spawn(spawn(ENGINEER, 'haiku'))
}

scenario('the route cap boundary: ROUTES_PER_SESSION routes are all kept, one more drops the oldest', { ...ENFORCE, max_parallel_agents: 500 }, async ($, seen) => {
  await spawnMany($, ROUTES_PER_SESSION)
  const key = 'spawns:0000001000000:sid-1'
  expect(seen.store[key]).toHaveLength(ROUTES_PER_SESSION)
  expect(seen.store[key]?.[0]?.agentId).toBe('ag-1')
  await spawnMany($, 1)
  expect(seen.store[key]).toHaveLength(ROUTES_PER_SESSION)
  expect(seen.store[key]?.[0]?.agentId).toBe('ag-2')
  expect(seen.store[key]?.at(-1)?.agentId).toBe(`ag-${ROUTES_PER_SESSION + 1}`)
})

scenario('observe: nothing is rewritten and nothing is logged for a designed model, under pressure or not', { policy_mode: 'observe', quota_pressure_percent: 80 }, async ($, seen) => {
  await $.session.measure(QUOTA)
  await $.agent.spawn(spawn(ENGINEER, 'opus'))
  expect(seen.sent).toEqual(['opus'])
  expect(seen.spawns?.[0]).toMatchObject({ requested: 'opus', decided: 'opus', ran: 'opus', applied: false })
})

const BARE = JSON.stringify({ pluginConfigs: { 'zetetic-autopilot': { options: { policy_mode: 'observe' } } } })

// The positive case (this copy IS the installed one) needs the folder the engine loads the mod from, which a
// test cannot know (`$.plugin.root` of a test hook is the test's own): it is tested in config.test.ts.
test('B2: a copy loaded by directory reads the bare key: the marketplace install beside it is no false alarm', { options: ENFORCE }, async ($, on) => {
  const seen = freshSeen()
  stubs(on, seen)
  seen.files['/home/t/.claude/settings.json'] = BARE
  seen.files['/home/t/.claude/plugins/installed_plugins.json'] = JSON.stringify({ plugins: { 'zetetic-autopilot@claude-mods': [{ installPath: '/some/other/install/folder' }] } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  expect(seen.decisions.filter((d) => d.kind === 'unread')).toEqual([])
  expect(seen.toasts).toEqual([])
})
