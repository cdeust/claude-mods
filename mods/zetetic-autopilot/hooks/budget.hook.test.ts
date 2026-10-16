import { expect, test } from 'claude-code/testing'

import { ENFORCE, ENGINEER, QUOTA, type Body, freshSeen, spawn, stubs } from './harness'

// Who is inside the orchestrator's budget (concurrency.ts, inBudget). The cap's refusal tells the caller to
// wait for a running agent and spawn again: only the main loop's own Agent calls can do that, and only they
// are counted. A subagent's nested spawn works inside the place its parent holds, a workflow script's agent()
// cannot wait (AgentSpawnInput.workflow: "A hook can only refuse it"), a teammate lives across turns.

const scenario = (name: string, options: Record<string, string | number>, body: Body) =>
  test(name, { options }, async ($, on) => {
    const seen = freshSeen()
    stubs(on, seen)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
    await body($, seen)
  })

type Extra = { parentAgentId?: string; workflow?: { runId: string; agentIndex: number }; isTeammate?: true; fork?: boolean }
// `model` null: the call names none.
const tryAgent = async ($: Parameters<Body>[0], extra: Extra = {}, type = ENGINEER, model: string | null = 'haiku') =>
  $.agent.spawn({ ...(spawn(type, model ?? undefined) as object), fork: false, ...extra } as never)

scenario('M-a: at cap 1 a running subagent can still delegate, and its child holds no place of its own', ENFORCE, async ($, seen) => {
  await $.session.measure(QUOTA)
  const parent = await tryAgent($)
  const child = await tryAgent($, { parentAgentId: (parent as { agentId: string }).agentId })
  expect(child).toMatchObject({ agentId: 'ag-2' })
  // main's own next spawn is still refused for the one place the parent holds, and the count is the parent alone
  expect((await tryAgent($)).deny).toContain('1 subagent is running and the cap is 1')
  expect(seen.decisions.filter((d) => d.kind === 'cap')).toHaveLength(1)
})

scenario('M-b: a workflow run fans out past the cap: none of its agents is refused or counted', ENFORCE, async ($) => {
  const out: string[] = []
  for (let i = 1; i <= 6; i++) out.push((await tryAgent($, { workflow: { runId: 'wf_1', agentIndex: i } })).deny === undefined ? 'ok' : 'DENY')
  expect(out.join(',')).toBe('ok,ok,ok,ok,ok,ok')
  // the orchestrator's own five places are all still free
  for (let i = 0; i < 5; i++) expect((await tryAgent($)).deny).toBeUndefined()
})

scenario('M-b: a teammate is neither refused nor counted', ENFORCE, async ($) => {
  await $.session.measure(QUOTA)
  await tryAgent($)
  expect(await tryAgent($, { isTeammate: true })).toMatchObject({ agentId: 'ag-2' })
})

// A fork from main is main's own Agent call (subagentType `fork`): main can wait and spawn again, so it counts.
scenario("a fork from main is inside main's budget: refused at cap 1 with one running", ENFORCE, async ($) => {
  await $.session.measure(QUOTA)
  await tryAgent($)
  expect((await tryAgent($, { fork: true }, 'fork', null)).deny).toContain('the cap is 1')
})

// The engine ignores a rewrite of a workflow agent's content and a fork's model (AgentSpawnInput.workflow,
// .model): none is sent, and the record says it was not applied.
scenario('a workflow agent of an inheriting type is not rewritten, and its route says not applied', ENFORCE, async ($, seen) => {
  await tryAgent($, { workflow: { runId: 'wf_1', agentIndex: 1 } }, 'Explore', null)
  expect(seen.sent).toEqual([undefined])
  expect(seen.spawns?.[0]).toMatchObject({ type: 'Explore', applied: false })
})

scenario('a fork reads no definition: no unread row, no rewrite', ENFORCE, async ($, seen) => {
  await tryAgent($, { fork: true }, 'fork', null)
  expect(seen.sent).toEqual([undefined])
  expect(seen.decisions.filter((d) => d.kind === 'unread')).toEqual([])
  expect(seen.spawns?.[0]).toMatchObject({ type: 'fork', reason: 'inherit', applied: false })
})
