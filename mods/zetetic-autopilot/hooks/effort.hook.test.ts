import { expect, test } from 'claude-code/testing'
import type { Plugin, TestBody } from 'claude-code/testing'

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
type Tool = { entered?: () => void; release?: Promise<void>; mainHeld?: Promise<void>; failing?: boolean }

const engine = (on: On, seen: Seen, steps: Step[], tool: Tool) => {
  stubs(on, seen)
  on('tool.call', async () => {
    tool.entered?.()
    await tool.release
    return { result: 'ok', text: 'ok' } as never
  })
  on('turn.step', async function* ($, e) {
    steps.push({ agentId: e.agentId, effort: e.effort })
    // A request that went out and whose stream then failed (an API error).
    if (tool.failing === true && e.agentId !== undefined) throw new Error('overloaded')
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
async function dispatch($: Engine, tool: Tool, input: Record<string, unknown>, call: { effort?: string | null } = {}) {
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

// Whether `p` settles within `turns` turns of the microtask queue: a bound counted in queue turns, not on a clock, so
// a step that waits forever fails an assertion instead of the kit's deadline.
const settles = async (p: Promise<unknown>, turns = 2000): Promise<boolean> => {
  let done = false
  void p.then(
    () => (done = true),
    () => (done = true),
  )
  for (let i = 0; i < turns && !done; i++) await Promise.resolve()
  return done
}

const KEY = 'spawns:0000001000000:sid-1'

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
  // Decided, and no step has carried it yet.
  expect(seen.spawns?.[0]).toMatchObject({ effort: 'medium', effortReason: 'grade', effortApplied: false })
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

scenario('I1: a background launch starts the run before its spawn answers: step 0 goes out at the decided effort too', ENFORCE, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  await mainStep($)
  let first: Promise<void> | undefined
  seen.launch = (id) => {
    seen.launch = undefined
    first = agentStep($, id, 0)
  }
  await dispatch($, tool, spawn('Explore'))
  await first
  await agentStep($, 'ag-1', 1)
  expect(sentFor(steps, 'ag-1')).toEqual(['medium', 'medium'])
  expect(seen.spawns?.[0]).toMatchObject({ effort: 'medium', effortReason: 'grade', effortApplied: true })
})

scenario('I1: a step passed down at the decided effort counts, even when its stream then failed (effortApplied: passed down, not proven sent)', ENFORCE, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  await mainStep($)
  await dispatch($, tool, spawn('Explore'))
  tool.failing = true
  await expect(agentStep($, 'ag-1', 0)).rejects.toThrow()
  expect(sentFor(steps, 'ag-1')).toEqual(['medium'])
  expect(seen.spawns?.[0]).toMatchObject({ effort: 'medium', effortApplied: true })
})

scenario('I1: a step of an agent whose spawn answered never waits on another spawn in flight', ENFORCE, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  await mainStep($)
  await dispatch($, tool, spawn(ARCHITECT))
  let entered = (): void => undefined
  let release = (): void => undefined
  const inside = new Promise<void>((r) => (entered = r))
  seen.hold = { entered: () => entered(), release: new Promise<void>((r) => (release = r)) }
  const second = dispatch($, tool, { ...(spawn('Explore') as object), tool_use_id: 'a2' })
  await inside
  // The Explore spawn is held at the engine: the architect's step goes out meanwhile, at the engine's effort.
  const step = agentStep($, 'ag-1', 0)
  expect(await settles(step)).toBe(true)
  expect(sentFor(steps, 'ag-1')).toEqual(['high'])
  seen.hold = undefined
  release()
  await second
  await agentStep($, 'ag-2', 0)
  expect(sentFor(steps, 'ag-2')).toEqual(['medium'])
})

// Review r2, N4: X (a pinned architect, nothing decided) is launched in the background while a decided Explore spawn Y
// is held at the engine; X's step 0 comes before X's spawn answers. It waits for its own answer, not for Y's.
scenario('I1: a step waiting on spawns in flight is released by its own spawn\'s answer', ENFORCE, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  await mainStep($)
  let entered = (): void => undefined
  let release = (): void => undefined
  const inside = new Promise<void>((r) => (entered = r))
  seen.hold = { entered: () => entered(), release: new Promise<void>((r) => (release = r)) }
  const y = dispatch($, tool, spawn('Explore'))
  await inside
  seen.hold = undefined
  let first: Promise<void> | undefined
  seen.launch = (id) => {
    seen.launch = undefined
    first = agentStep($, id, 0)
  }
  let answer = (): void => undefined
  seen.answerHeld = new Promise<void>((r) => (answer = r))
  const x = dispatch($, tool, { ...(spawn(ARCHITECT) as object), tool_use_id: 'a2' })
  // The engine names agents in the order they reach it: X is ag-1, Y (still held) will be ag-2.
  for (let i = 0; i < 2000 && first === undefined; i++) await Promise.resolve()
  if (first === undefined) throw new Error('the spawn never launched its run')
  // X's step came before X's answer: it is parked.
  expect(await settles(first)).toBe(false)
  answer()
  await x
  // X answered; Y is still held. X's step goes out now, at the engine's effort.
  expect(await settles(first)).toBe(true)
  await first
  expect(sentFor(steps, 'ag-1')).toEqual(['high'])
  release()
  await y
  await agentStep($, 'ag-2', 0)
  expect(sentFor(steps, 'ag-2')).toEqual(['medium'])
})

// Review r2, R3: the first run ended before any step, so its record says not applied; the resumed run's step marks the
// resumed run's record only.
scenario('I1: a step marks its run\'s record only, never an earlier run\'s', ENFORCE, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  await mainStep($)
  await dispatch($, tool, spawn('general-purpose'))
  await $.turn.complete(done('ag-1'))
  expect(seen.spawns?.[0]).toMatchObject({ effort: 'medium', effortApplied: false })
  seen.resumes = 'ag-1'
  await $.agent.spawn({ ...(spawn('general-purpose') as object), tool_use_id: 'send-1', resume: { agentId: 'ag-1' } } as never)
  await agentStep($, 'ag-1', 0)
  expect(seen.spawns?.[1]).toMatchObject({ effortReason: 'resumed', effortApplied: true })
  expect(seen.spawns?.[0]).toMatchObject({ effortApplied: false })
  expect(seen.store[KEY]?.[0]).toMatchObject({ effortApplied: false })
  expect(seen.store[KEY]?.[1]).toMatchObject({ effortApplied: true })
})

// Review r2, R2: a store write the engine refuses is a named row, and the writes after it still land.
scenario('a refused store write is a row, and the next spawn\'s record and its mark are still written', ENFORCE, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  await mainStep($)
  seen.failStoreSet = 1
  await dispatch($, tool, spawn('Explore'))
  expect(seen.decisions.some((d) => d.kind === 'unread' && d.subject === 'spawn records')).toBe(true)
  expect(seen.store[KEY]).toBeUndefined()
  await dispatch($, tool, { ...(spawn('Explore') as object), tool_use_id: 'a2' })
  expect(seen.store[KEY]?.map((r) => r.agentId)).toEqual(['ag-2'])
  await agentStep($, 'ag-2', 0)
  expect(seen.store[KEY]?.[0]).toMatchObject({ agentId: 'ag-2', effortApplied: true })
})

// Review r2, R2: the store write fails and so does the row that would name it (the policy state is refused too): that
// spawn's record is lost, the next one's is still written.
scenario('a store write whose row also fails does not stop the writes after it', ENFORCE, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  await mainStep($)
  seen.failStoreSet = 1
  // The spawn's model row and effort row land; the third policy write, the row naming the refused store write, fails.
  seen.failStateSet = { key: 'policy', count: 1, skip: 2 }
  await dispatch($, tool, spawn('Explore')).catch(() => undefined)
  await dispatch($, tool, { ...(spawn('Explore') as object), tool_use_id: 'a2' })
  expect(seen.store[KEY]?.map((r) => r.agentId)).toEqual(['ag-2'])
})

// Review r2, N5: the mark is bookkeeping; when its write is refused, the step still ends as its stream did.
scenario('a mark whose write is refused neither fails a clean step nor replaces a failed stream\'s error', ENFORCE, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  await mainStep($)
  await dispatch($, tool, spawn('Explore'))
  seen.failStateSet = { key: 'spawns', count: 1 }
  await agentStep($, 'ag-1', 0)
  expect(sentFor(steps, 'ag-1')).toEqual(['medium'])
  expect(seen.decisions.some((d) => d.kind === 'unread' && d.subject === 'spawn records')).toBe(true)
  await dispatch($, tool, { ...(spawn('Explore') as object), tool_use_id: 'a2' })
  seen.failStateSet = { key: 'spawns', count: 1 }
  tool.failing = true
  // (The kit answers a failing stream with its own error; what matters is that the mark's error does not replace it.)
  const error = await agentStep($, 'ag-2', 0).then(
    () => undefined,
    (e: unknown) => String(e),
  )
  expect(error).toBeDefined()
  expect(error).not.toContain('spawns state offline')
})

// Review r3, S2: the mark's write is refused and so is the row that would name it: the step still ends cleanly.
// The kit keeps a step's result when a hook fails after `next` (outcome `kept`), so the step resolving says nothing:
// a plugin above the mod reads how the mod's link settled (`next.trace`), which must be a clean answer. The plugin runs
// in its own realm, so it reports through a toast the test's stubs record.
const WATCH: Plugin = {
  name: 'watch',
  tier: 'prepend',
  register: (on) => {
    on('turn.step', async function* ($, e, next) {
      const r = yield* next(e)
      const own = next.trace.find((t) => t.plugin === 'zetetic-autopilot')
      if (e.agentId !== undefined && own !== undefined) $.ui.toast(`watch: ${own.outcome}`)
      return r
    })
  },
}

test('a mark whose write and whose row are both refused still lets the step end as the mod\'s own answer', { options: ENFORCE, plugins: [WATCH] }, async ($, on) => {
  const seen = freshSeen()
  const steps: Step[] = []
  const tool: Tool = {}
  engine(on, seen, steps, tool)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  seen.grade = ANALYSIS
  await mainStep($)
  await dispatch($, tool, spawn('Explore'))
  seen.failStateSet = [
    { key: 'spawns', count: 1 },
    { key: 'policy', count: 1 },
  ]
  seen.toasts.length = 0
  await agentStep($, 'ag-1', 0)
  expect(sentFor(steps, 'ag-1')).toEqual(['medium'])
  const outcomes = seen.toasts.filter((t) => t.startsWith('watch: '))
  expect(outcomes).toHaveLength(1)
  expect(['watch: returned', 'watch: passed']).toContain(outcomes[0])
})

// Review r2, R1: JSON's null is a call that named no effort.
scenario('I2: a call effort of null is no effort: the grade decides', ENFORCE, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  await mainStep($)
  await dispatch($, tool, spawn('Explore'), { effort: null })
  await agentStep($, 'ag-1', 0)
  expect(sentFor(steps, 'ag-1')).toEqual(['medium'])
  expect(seen.spawns?.[0]).toMatchObject({ effort: 'medium', effortReason: 'grade', effortApplied: true })
})

scenario('I1: a resumed run none of whose steps carried the effort is not recorded as applied', ENFORCE, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  await mainStep($)
  await dispatch($, tool, spawn('general-purpose'))
  await agentStep($, 'ag-1', 0)
  await $.turn.complete(done('ag-1'))
  seen.resumes = 'ag-1'
  await $.agent.spawn({ ...(spawn('general-purpose') as object), tool_use_id: 'send-1', resume: { agentId: 'ag-1' } } as never)
  await agentStep($, 'ag-1', 0, 'none')
  expect(seen.spawns?.[0]).toMatchObject({ effortApplied: true })
  expect(seen.spawns?.[1]).toMatchObject({ effortReason: 'resumed', effortApplied: false })
})

scenario('I1: a resumed run that steps before its spawn answers is recorded as carried', ENFORCE, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  await mainStep($)
  await dispatch($, tool, spawn('general-purpose'))
  await agentStep($, 'ag-1', 0)
  await $.turn.complete(done('ag-1'))
  let first: Promise<void> | undefined
  seen.resumes = 'ag-1'
  seen.launch = (id) => {
    seen.launch = undefined
    first = agentStep($, id, 0)
  }
  await $.agent.spawn({ ...(spawn('general-purpose') as object), tool_use_id: 'send-1', resume: { agentId: 'ag-1' } } as never)
  await first
  expect(sentFor(steps, 'ag-1')).toEqual(['medium', 'medium'])
  expect(seen.spawns?.[1]).toMatchObject({ agentId: 'ag-1', effortReason: 'resumed', effortApplied: true })
})

scenario('I1: a resumed run of the agent, after its turn ended, keeps the decided effort', ENFORCE, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  await mainStep($)
  await dispatch($, tool, spawn('general-purpose'))
  await agentStep($, 'ag-1', 0)
  await $.turn.complete(done('ag-1'))
  // A message resumes it under the same id; the engine raises the spawn again with the message's call, not an Agent one.
  seen.resumes = 'ag-1'
  await $.agent.spawn({ ...(spawn('general-purpose') as object), tool_use_id: 'send-1' } as never)
  expect(seen.spawns?.[1]).toMatchObject({ agentId: 'ag-1', effortReason: 'resumed', effortApplied: false })
  await agentStep($, 'ag-1', 0)
  expect(sentFor(steps, 'ag-1')).toEqual(['medium', 'medium'])
  // The resume's record names the effort the steps keep, not the unseen call's nothing.
  expect(seen.spawns?.[1]).toMatchObject({ agentId: 'ag-1', effort: 'medium', effortReason: 'resumed', effortApplied: true })
})

scenario('I2: the Agent call\'s own effort stands', ENFORCE, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  await mainStep($)
  await dispatch($, tool, spawn('Explore'), { effort: 'high' })
  await agentStep($, 'ag-1', 0)
  expect(sentFor(steps, 'ag-1')).toEqual(['high'])
  expect(seen.spawns?.[0]).toMatchObject({ effort: null, effortReason: 'call' })
})

// 2.1.304 also takes the relative levels `lower` and `higher` on the call (behind a feature flag): an effort the
// call names stands, whatever its value.
scenario('I2: a call effort that is not one of the five levels stands too', ENFORCE, async ($, seen, steps, tool) => {
  seen.grade = ANALYSIS
  await mainStep($)
  await dispatch($, tool, spawn('Explore'), { effort: 'higher' })
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
  // No step carried the decided effort: the record does not say it was applied.
  expect(seen.spawns?.[0]).toMatchObject({ effort: 'medium', effortReason: 'grade', effortApplied: false })
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
