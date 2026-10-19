import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { ARCHITECT, ENFORCE, FABLE, type Seen, done, freshSeen, spawn, stubs } from './harness'

// A subagent's effort (effort.ts). The invariant, clause by clause:
//   I1  every step of an agent the mod decided an effort for goes out at that effort (under enforce);
//   I2  an effort the Agent call or the agent's definition set is never overwritten, and an agent the mod
//       decided nothing for steps at the effort the engine sent;
//   I3  the decision is the grade's: only an inheriting type (its definition pins no model) whose call and
//       definition set no effort, spawned by main on a turn the classifier graded, gets one;
//   I4  what was decided is kept per spawn, in the state and the store (the bound is effort.test.ts).

type Step = { agentId?: string; effort?: unknown }
type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

// The Agent tool as the engine runs it: `tool.call` reaches the bottom (the tool runs) and the spawn is raised from
// inside the tool, while the call is still running (2.1.304: the Agent tool raises agent.spawn from its `call`, which
// runs beneath every tool.call hook). The tool answers once the test released it.
type Tool = { entered?: () => void; release?: Promise<void>; mainHeld?: Promise<void> }

const engine = (on: On, seen: Seen, steps: Step[], tool: Tool) => {
  stubs(on, seen)
  on('tool.call', async () => {
    tool.entered?.()
    await tool.release
    return { result: 'ok', text: 'ok' } as never
  })
  on('turn.step', async function* ($, e) {
    steps.push({ agentId: e.agentId, effort: e.effort })
    yield { kind: 'text', index: 0, text: 'ok' }
    // A main step whose stream the test holds open: the engine runs its tool calls before the step's stream ended.
    if (e.agentId === undefined) await tool.mainHeld
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
}

const drain = async (stream: AsyncGenerator<unknown, unknown>) => {
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
}

// The model's Agent call, and the spawn its tool raises while the call runs.
async function dispatch($: Engine, tool: Tool, input: Record<string, unknown>, call: { effort?: string } = {}) {
  let release = (): void => undefined
  tool.release = new Promise<void>((r) => (release = r))
  const entered = new Promise<void>((r) => (tool.entered = r))
  const args = { tool: 'Agent', tool_use_id: input.tool_use_id, description: 'd', prompt: 'p', subagent_type: input.subagentType, ...call }
  const ran = $.tool.call(args as never)
  await entered
  const spawned = await $.agent.spawn(input as never)
  release()
  await ran
  return spawned
}

const MAIN_TURN = 't'
const ANALYSIS = { turnId: MAIN_TURN, taskClass: 'analysis', effort: 'medium' }

// Main's first step of the graded turn binds the grade to the turn (the router reads it only for that turn).
const mainStep = ($: Engine) => drain($.turn.step({ turnId: MAIN_TURN, index: 0, model: FABLE, effort: 'high', messageCount: 1 }))
// A step as the engine sends it: at `high` (the session's setting), or with no effort at all (`none`: a model without one).
const agentStep = ($: Engine, agentId: string, index: number, effort: 'high' | 'none' = 'high') =>
  drain($.turn.step({ turnId: `t-${agentId}`, index, model: 'claude-sonnet-5-5', ...(effort === 'none' ? {} : { effort }), messageCount: 3, agentId }))

const sentFor = (steps: Step[], agentId: string) => steps.filter((s) => s.agentId === agentId).map((s) => s.effort)

const scenario = (name: string, options: Record<string, string | number>, body: (engine: Engine, seen: Seen, steps: Step[], tool: Tool) => Promise<void>) =>
  test(name, { options }, async ($, on) => {
    const seen = freshSeen()
    const steps: Step[] = []
    const tool: Tool = {}
    engine(on, seen, steps, tool)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
    await body($, seen, steps, tool)
  })

const SCOUT = 'zetetic-team-subagents:scout'
const scoutDefinedAt = (seen: Seen, frontmatter: string) => {
  seen.files['/c/zetetic/2.44.0/agents/scout.md'] = `---\nname: scout\n${frontmatter}---\n`
}

scenario('I1: an inheriting Explore whose call set no effort runs every step at the graded turn\'s effort', ENFORCE, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  await mainStep($)
  const r = await dispatch($, tool, spawn('Explore'))
  expect(r.agentId).toBe('ag-1')
  await agentStep($, 'ag-1', 0)
  await agentStep($, 'ag-1', 3)
  expect(sentFor(steps, 'ag-1')).toEqual(['medium', 'medium'])
  expect(seen.spawns?.[0]).toMatchObject({ agentId: 'ag-1', effort: 'medium', effortReason: 'grade', effortApplied: true })
  expect(seen.decisions.find((d) => d.kind === 'effort' && d.subject.startsWith('Explore'))).toMatchObject({ to: 'medium', applied: true })
})

scenario('I3: a spawn raised while main\'s step is still streaming (its first turn) is graded by that turn', ENFORCE, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  let release = (): void => undefined
  tool.mainHeld = new Promise<void>((r) => (release = r))
  const main = $.turn.step({ turnId: MAIN_TURN, index: 0, model: FABLE, effort: 'high', messageCount: 1 })
  await main.next()
  await dispatch($, tool, spawn('Explore'))
  release()
  await drain(main)
  await agentStep($, 'ag-1', 0)
  expect(sentFor(steps, 'ag-1')).toEqual(['medium'])
  expect(seen.spawns?.[0]).toMatchObject({ effort: 'medium', effortReason: 'grade', reason: 'kind', decided: 'sonnet' })
})

scenario('I1: a resumed run of the agent, after its turn ended, keeps the decided effort', ENFORCE, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  await mainStep($)
  await dispatch($, tool, spawn('general-purpose'))
  await agentStep($, 'ag-1', 0)
  await $.turn.complete(done('ag-1'))
  // A message resumes it under the same id; the engine raises the spawn again with the message's call, not an Agent one.
  await $.agent.spawn({ ...(spawn('general-purpose') as object), tool_use_id: 'send-1' } as never)
  await agentStep($, 'ag-1', 0)
  expect(sentFor(steps, 'ag-1')).toEqual(['medium', 'medium'])
})

scenario('I2: the Agent call\'s own effort stands', ENFORCE, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  await mainStep($)
  await dispatch($, tool, spawn('Explore'), { effort: 'high' })
  await agentStep($, 'ag-1', 0)
  expect(sentFor(steps, 'ag-1')).toEqual(['high'])
  expect(seen.spawns?.[0]).toMatchObject({ effort: null, effortReason: 'call' })
})

scenario('I2: the definition\'s own effort stands, on an inheriting definition too', ENFORCE, async ($, seen, steps, tool) => {
  scoutDefinedAt(seen, 'model: inherit\neffort: high\n')
  seen.grade = ANALYSIS
  await mainStep($)
  await dispatch($, tool, spawn(SCOUT))
  await agentStep($, 'ag-1', 0)
  expect(sentFor(steps, 'ag-1')).toEqual(['high'])
  expect(seen.spawns?.[0]).toMatchObject({ effort: null, effortReason: 'definition' })
})

scenario('I3: a definition that pins a model is not an inheriting type: its steps keep the engine\'s effort', ENFORCE, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  await mainStep($)
  await dispatch($, tool, spawn(ARCHITECT))
  await agentStep($, 'ag-1', 0)
  expect(sentFor(steps, 'ag-1')).toEqual(['high'])
  expect(seen.spawns?.[0]).toMatchObject({ effort: null, effortReason: 'pinned' })
})

scenario('I3: an inheriting type the call gave a model, with no effort, takes the grade\'s effort', ENFORCE, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  await mainStep($)
  await dispatch($, tool, spawn('general-purpose', 'opus'))
  await agentStep($, 'ag-1', 0)
  expect(sentFor(steps, 'ag-1')).toEqual(['medium'])
  expect(seen.spawns?.[0]).toMatchObject({ requested: 'opus', effort: 'medium', effortReason: 'grade' })
})

scenario('I3: with no grade bound to the turn nothing is decided', ENFORCE, async ($, seen, steps, tool) => {
  await mainStep($)
  await dispatch($, tool, spawn('Explore'))
  await agentStep($, 'ag-1', 0)
  expect(sentFor(steps, 'ag-1')).toEqual(['high'])
  expect(seen.spawns?.[0]).toMatchObject({ effort: null, effortReason: 'ungraded' })
})

scenario('I3: a spawn whose Agent call was not seen (its effort unknown) is left as the engine sends it', ENFORCE, async ($, seen, steps) => {
  seen.grade = ANALYSIS
  await mainStep($)
  await $.agent.spawn(spawn('Explore'))
  await agentStep($, 'ag-1', 0)
  expect(sentFor(steps, 'ag-1')).toEqual(['high'])
  expect(seen.spawns?.[0]).toMatchObject({ effort: null, effortReason: 'unseen' })
})

scenario('I3: a fork runs at its parent\'s effort', ENFORCE, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  await mainStep($)
  await dispatch($, tool, { ...(spawn('fork') as object), fork: true })
  await agentStep($, 'ag-1', 0)
  expect(sentFor(steps, 'ag-1')).toEqual(['high'])
  expect(seen.spawns?.[0]).toMatchObject({ effort: null, effortReason: 'fixed' })
})

scenario('I3: a subagent\'s own spawn is not graded by main\'s turn', ENFORCE, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  await mainStep($)
  await dispatch($, tool, { ...(spawn('Explore') as object), parentAgentId: 'ag-0' })
  await agentStep($, 'ag-1', 0)
  expect(sentFor(steps, 'ag-1')).toEqual(['high'])
  expect(seen.spawns?.[0]).toMatchObject({ effort: null, effortReason: 'ungraded' })
})

scenario('I1: a step that carries no effort (a model without one) is not given one', ENFORCE, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  await mainStep($)
  await dispatch($, tool, spawn('Explore'))
  await agentStep($, 'ag-1', 0, 'none')
  expect(sentFor(steps, 'ag-1')).toEqual([undefined])
})

scenario('observe: the decision is a row and in the record, and every step goes out as the engine sent it', { policy_mode: 'observe', quota_pressure_percent: 80 }, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  await mainStep($)
  await dispatch($, tool, spawn('Explore'))
  await agentStep($, 'ag-1', 0)
  await agentStep($, 'ag-1', 1)
  expect(sentFor(steps, 'ag-1')).toEqual(['high', 'high'])
  expect(seen.spawns?.[0]).toMatchObject({ effort: 'medium', effortReason: 'grade', effortApplied: false })
  expect(seen.decisions.filter((d) => d.kind === 'effort' && d.subject.startsWith('Explore'))).toEqual([
    expect.objectContaining({ to: 'medium', applied: false }),
  ])
})

scenario('main\'s steps are not touched by a subagent\'s decision, and one row is logged per spawn, not per step', ENFORCE, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  await mainStep($)
  await dispatch($, tool, spawn('Explore'))
  for (let i = 0; i < 4; i++) await agentStep($, 'ag-1', i)
  expect(steps.filter((s) => s.agentId === undefined).map((s) => s.effort)).toEqual(['medium'])
  expect(seen.decisions.filter((d) => d.kind === 'effort' && d.subject.startsWith('Explore'))).toHaveLength(1)
})
