import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { ENFORCE, ENGINEER, FABLE, QUOTA, type Seen, type Tool, agentTool, dispatch, done, freshSeen, graded, spawn, stubs } from './harness'

// The dispatch table at the spawn (ADR-9851): who is classified, what the table decides for the model and for every
// step's effort, what DESIGN and an explicit model keep, and what a failed classifier leaves (nothing, and a row).

type Engine = Parameters<TestBody>[0]
type Step = { agentId?: string; effort?: unknown }

type Options = Record<string, string | number>
type Scenario = (engine: Engine, seen: Seen, steps: Step[], tool: Tool) => Promise<void>

const scenario = (name: string, options: Options, body: Scenario) =>
  test(name, { options }, async ($, on) => {
    const seen = freshSeen()
    const steps: Step[] = []
    const tool: Tool = {}
    stubs(on, seen)
    agentTool(on, tool)
    on('turn.step', async function* ($, e) {
      steps.push({ agentId: e.agentId, effort: e.effort })
      yield { kind: 'text', index: 0, text: 'ok' }
      return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
    await body($, seen, steps, tool)
  })

const drain = async (stream: AsyncGenerator<unknown, unknown>) => {
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
}

// A step of the agent as the engine sends it, at `high` (the session's setting).
const agentStep = ($: Engine, agentId: string, index = 0) =>
  drain($.turn.step({ turnId: `t-${agentId}`, index, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 3, agentId }))
const sentFor = (steps: Step[], agentId: string) => steps.filter((s) => s.agentId === agentId).map((s) => s.effort)
const withPrompt = (type: string, prompt: string, extra: Record<string, unknown> = {}) => ({ ...(spawn(type) as object), prompt, ...extra })

const ANALYSIS_GRADE = { turnId: 't', taskClass: 'analysis', effort: 'medium' }
const mainStep = ($: Engine) => drain($.turn.step({ turnId: 't', index: 0, model: FABLE, effort: 'high', messageCount: 1 }))

scenario('an inheriting Explore nobody designed runs at the table\'s rung for its task\'s class, model and every step', ENFORCE, async ($, seen, steps, tool) => {
  seen.classifier = graded('analysis')
  await dispatch($, tool, withPrompt('Explore', 'Map how the parser and the router share state across the repo.'))
  expect(seen.asked).toHaveLength(1)
  expect(seen.asked[0]).toMatchObject({ model: 'haiku', effort: 'low' })
  expect(seen.asked[0]?.prompt).toContain('Agent type: Explore')
  expect(seen.asked[0]?.prompt).toContain('Map how the parser')
  expect(seen.sent).toEqual(['opus'])
  await agentStep($, 'ag-1')
  await agentStep($, 'ag-1', 1)
  expect(sentFor(steps, 'ag-1')).toEqual(['medium', 'medium'])
  expect(seen.spawns?.[0]).toMatchObject({ reason: 'table', decided: 'opus', applied: true, cls: 'analysis', review: false, effort: 'medium', effortReason: 'table', effortApplied: true })
  expect(seen.decisions.find((d) => d.kind === 'model')).toMatchObject({ subject: 'Explore · analysis', to: 'opus', applied: true, reason: "analysis task: the table's rung opus/medium" })
  expect(seen.decisions.find((d) => d.kind === 'effort')).toMatchObject({ to: 'medium', from: 'the dispatch table', applied: true })
})

scenario('each row reaches the spawn: every class, as a task and as a review', ENFORCE, async ($, seen, steps, tool) => {
  const want: [string, boolean, string, string][] = [
    ['routine', false, 'sonnet', 'low'],
    ['planned', false, 'sonnet', 'low'],
    ['bugfix', false, 'sonnet', 'medium'],
    ['analysis', false, 'opus', 'medium'],
    ['critical', false, 'opus', 'high'],
    ['routine', true, 'sonnet', 'medium'],
    ['planned', true, 'sonnet', 'medium'],
    ['bugfix', true, 'sonnet', 'medium'],
    ['analysis', true, 'opus', 'medium'],
    ['critical', true, 'opus', 'high'],
  ]
  for (const [i, [cls, review, model, effort]] of want.entries()) {
    seen.classifier = graded(cls, review)
    const id = `ag-${i + 1}`
    await dispatch($, tool, { ...(spawn('general-purpose') as object), tool_use_id: `a${i}` })
    await agentStep($, id)
    expect([cls, review, seen.sent.at(-1), sentFor(steps, id)]).toEqual([cls, review, model, [effort]])
    expect(seen.spawns?.at(-1)).toMatchObject({ reason: 'table', cls, review, decided: model, effort, effortReason: 'table' })
    await $.turn.complete(done(id))
  }
})

scenario('pressure does not change the output: the same task gets the same rung with the five-hour window full', ENFORCE, async ($, seen, steps, tool) => {
  seen.classifier = graded('critical')
  await dispatch($, tool, spawn('Explore'))
  await agentStep($, 'ag-1')
  await $.turn.complete(done('ag-1'))
  await $.session.measure(QUOTA)
  await dispatch($, tool, { ...(spawn('Explore') as object), tool_use_id: 'a2' })
  await agentStep($, 'ag-2')
  expect(seen.sent).toEqual(['opus', 'opus'])
  expect([sentFor(steps, 'ag-1'), sentFor(steps, 'ag-2')]).toEqual([['high'], ['high']])
  const rows = seen.spawns?.map((r) => [r.decided, r.reason, r.effort, r.effortReason])
  expect(rows?.[0]).toEqual(rows?.[1])
})

scenario('DESIGN decides before the table: no completion is spent, its model and effort run', ENFORCE, async ($, seen, steps, tool) => {
  seen.classifier = graded('routine')
  await dispatch($, tool, withPrompt('general-purpose', 'DESIGN\ntask: x\nmodel: opus · effort: high · why: y\n\nDo it.'))
  await agentStep($, 'ag-1')
  expect(seen.asked).toEqual([])
  expect(seen.sent).toEqual(['opus'])
  expect(sentFor(steps, 'ag-1')).toEqual(['high'])
  expect(seen.spawns?.[0]).toMatchObject({ reason: 'design', effortReason: 'design' })
  expect(seen.spawns?.[0]?.cls).toBeUndefined()
})

scenario('a DESIGN value that is no model or effort is a row, never guessed; with nothing designed the table decides', ENFORCE, async ($, seen, steps, tool) => {
  seen.classifier = graded('bugfix')
  await dispatch($, tool, withPrompt('general-purpose', 'DESIGN\nmodel: the best one\n\nFix it.'))
  expect(seen.decisions.find((d) => d.kind === 'unread' && d.subject === 'general-purpose DESIGN')?.to).toBe("model 'the best one' names no single model family")
  expect(seen.asked).toHaveLength(1)
  expect(seen.spawns?.[0]).toMatchObject({ reason: 'table', cls: 'bugfix', decided: 'sonnet' })
})

scenario('a pinned model is never rewritten: a call model and a definition pin stand against DESIGN, and nothing is classified', ENFORCE, async ($, seen, steps, tool) => {
  seen.classifier = graded('critical')
  await dispatch($, tool, withPrompt('Explore', 'DESIGN\nmodel: opus\n\nlook', { model: 'haiku' }))
  await $.turn.complete(done('ag-1'))
  await dispatch($, tool, withPrompt(ENGINEER, 'DESIGN\nmodel: haiku · effort: low\n\nbuild', { tool_use_id: 'a2' }))
  await agentStep($, 'ag-2')
  expect(seen.sent).toEqual(['haiku', undefined])
  expect(seen.spawns?.map((r) => [r.reason, r.decided])).toEqual([
    ['call', 'haiku'],
    ['definition', 'sonnet'],
  ])
  // The engineer's definition sets its effort (medium): DESIGN's does not overwrite it.
  expect(sentFor(steps, 'ag-2')).toEqual(['high'])
  expect(seen.spawns?.[1]).toMatchObject({ effortReason: 'definition' })
  expect(seen.asked).toEqual([])
})

for (const [name, why, classifier] of [
  ['aborted', /^aborted$/, { fails: 'aborted' }],
  ['api-error', /^api-error 529 overloaded$/, { fails: 'api-error' }],
  ['off-contract', /^answered off-contract: \{"task_class":"easy"\}$/, { answer: '{"task_class":"easy"}' }],
  ['refused', /^refused: .*model blocked$/, { rejects: 'model blocked' }],
] as const) {
  scenario(`a classifier that gives no class (${name}) decides nothing: a row, the spawn inherits, no grade in its place`, ENFORCE, async ($, seen, steps, tool) => {
    seen.classifier = classifier
    seen.grade = ANALYSIS_GRADE
    await mainStep($)
    await dispatch($, tool, spawn('Explore'))
    await agentStep($, 'ag-1')
    expect(seen.sent).toEqual([undefined])
    expect(sentFor(steps, 'ag-1')).toEqual(['high'])
    expect(seen.spawns?.[0]).toMatchObject({ reason: 'unclassified', effort: null, effortReason: 'unclassified', applied: false })
    const row = seen.decisions.find((d) => d.kind === 'unread' && d.subject === 'Explore task class')
    expect(row?.to).toMatch(why)
  })
}

scenario('every unclassified spawn is its own row, not one per reason', ENFORCE, async ($, seen, steps, tool) => {
  seen.classifier = { fails: 'aborted' }
  await dispatch($, tool, spawn('Explore'))
  await dispatch($, tool, { ...(spawn('Explore') as object), tool_use_id: 'a2' })
  expect(seen.decisions.filter((d) => d.subject === 'Explore task class')).toHaveLength(2)
})

scenario('a fork, a teammate, a workflow agent and a spawn no Agent call was seen for are never classified', ENFORCE, async ($, seen, steps, tool) => {
  seen.classifier = graded('critical')
  await dispatch($, tool, { ...(spawn('fork') as object), fork: true })
  await dispatch($, tool, { ...(spawn('general-purpose') as object), tool_use_id: 'a2', isTeammate: true })
  await dispatch($, tool, { ...(spawn('general-purpose') as object), tool_use_id: 'a3', workflow: { name: 'w' } })
  await $.agent.spawn({ ...(spawn('Explore') as object), tool_use_id: 'unseen' } as never)
  expect(seen.asked).toEqual([])
  expect(seen.sent).toEqual([undefined, undefined, undefined, undefined])
  expect(seen.spawns?.map((r) => r.reason)).toEqual(['inherit', 'inherit', 'inherit', 'inherit'])
})

scenario('a subagent\'s own spawn is classified too: the table reads the spawn\'s task, not main\'s turn', ENFORCE, async ($, seen, steps, tool) => {
  seen.classifier = graded('planned')
  await dispatch($, tool, { ...(spawn('Explore') as object), parentAgentId: 'ag-0' })
  await agentStep($, 'ag-1')
  expect(seen.sent).toEqual(['sonnet'])
  expect(sentFor(steps, 'ag-1')).toEqual(['low'])
  expect(seen.spawns?.[0]).toMatchObject({ reason: 'table', cls: 'planned', effortReason: 'table' })
})

scenario('the call\'s own effort stands beside the table\'s model', ENFORCE, async ($, seen, steps, tool) => {
  seen.classifier = graded('analysis')
  await dispatch($, tool, spawn('Explore'), { effort: 'low' })
  await agentStep($, 'ag-1')
  expect(seen.sent).toEqual(['opus'])
  expect(sentFor(steps, 'ag-1')).toEqual(['high'])
  expect(seen.spawns?.[0]).toMatchObject({ reason: 'table', effortReason: 'call' })
})

scenario('observe: the table\'s decision is a row and a record, nothing is rewritten', { policy_mode: 'observe', quota_pressure_percent: 80 }, async ($, seen, steps, tool) => {
  seen.classifier = graded('analysis')
  await dispatch($, tool, spawn('Explore'))
  await agentStep($, 'ag-1')
  expect(seen.sent).toEqual([undefined])
  expect(sentFor(steps, 'ag-1')).toEqual(['high'])
  expect(seen.decisions.find((d) => d.kind === 'model')).toMatchObject({ to: 'opus', applied: false })
  expect(seen.spawns?.[0]).toMatchObject({ reason: 'table', decided: 'opus', applied: false, effort: 'medium', effortApplied: false })
})
