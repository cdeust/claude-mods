import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { PhasesState, PolicyDecision } from '../types'

// Wiring tests: the phases row of main and of a subagent, filled from the steps' results.

const seenPhases = (on: Parameters<TestBody>[1], files: Record<string, string> = {}): { value?: PhasesState; decisions?: PolicyDecision[] } => {
  const seen: { value?: PhasesState; decisions?: PolicyDecision[] } = {}
  mock.clock(on, { now: 1_000_000 })
  on('session.start', () => ({ cwd: '/r' }))
  on('session.cwd', () => ({ value: '/r' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0 } } as never }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('env.get', ($, e) => ({ value: ((e as { name?: string }).name === 'HOME' ? '/home/t' : undefined) as never }))
  on('fs.exists', ($, e) => ({ value: String((e as { path?: string }).path) in files }))
  on('fs.read', ($, e) => {
    const text = files[String((e as { path?: string }).path)]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('state.get', ($, e, next) =>
    (e as { plugin?: string }).plugin === 'zetetic-genius' ? { value: { value: undefined, version: 0 } as never } : next(e),
  )
  on('state.set', ($, e, next) => {
    if ((e as { key?: string }).key === 'phases') seen.value = (e as unknown as { value: PhasesState }).value
    if ((e as { key?: string }).key === 'policy') seen.decisions = (e as unknown as { value: { decisions: PolicyDecision[] } }).value.decisions
    return next(e)
  })
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  return seen
}

// The engine's answer to a step: the tool calls it asks for, and the advisor if it ran.
const answering = (on: Parameters<TestBody>[1], toolUses: { id: string; name: string; input: unknown }[], advisor = 0) =>
  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: '' }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: toolUses.length === 0 ? 'done' : '',
      toolUses,
      serverToolUses: Array.from({ length: advisor }, (_, i) => ({ id: `s${i}`, name: 'advisor', input: {}, startedAt: 1, endedAt: 2 })),
      stopReason: toolUses.length === 0 ? 'end_turn' : 'tool_use',
      usage: null,
    }
  })

const drain = async (stream: AsyncGenerator<unknown, unknown>) => {
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
}

test('a main step that edits a file puts main in implementation and counts its advisor call', { options: { policy_mode: 'enforce' } }, async ($, on) => {
  const seen = seenPhases(on)
  answering(on, [{ id: 'c1', name: 'Edit', input: { file_path: '/r/src/a.ts' } }], 1)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.turn.start({ turnId: 't1', text: 'fix it' } as never)
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 1 }))
  const main = seen.value?.loops.find((l) => l.id === 'main')
  expect(main?.phase).toBe('implementation')
  expect(main?.effort).toBe('medium')
  expect(seen.value?.advisor.uses.map((u) => u.when)).toEqual(['before-write'])
})

test('a step sent with no effort is recorded at the model default, never as an unknown rung', { options: { policy_mode: 'observe' } }, async ($, on) => {
  const seen = seenPhases(on)
  answering(on, [{ id: 'c1', name: 'Read', input: { file_path: '/r/src/a.ts' } }], 0)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.turn.start({ turnId: 't1', text: 'look' } as never)
  await drain($.turn.step({ turnId: 't1', index: 1, model: 'claude-sonnet-5-5', messageCount: 1 }))
  const main = seen.value?.loops.find((l) => l.id === 'main')
  // source: policy.ts DEFAULT_EFFORT, Sonnet 5.5's API default is high.
  expect(main?.runs.map((r) => r.effort)).toEqual(['high'])
})

test('a spawned reviewer gets a row in review, with the model the engine resolved', { options: { policy_mode: 'enforce' } }, async ($, on) => {
  const seen = seenPhases(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.agent.spawn({
    tool_use_id: 'u1',
    prompt: 'p',
    description: 'review the diff',
    subagentType: 'Explore',
    provider: { kind: 'model', model: 'claude-opus-5-5' },
    parentModel: 'claude-opus-5-5',
  } as never)
  const row = seen.value?.loops.find((l) => l.id === 'a1')
  expect(row?.phase).toBe('analysis')
  expect(row?.model).toBe('claude-haiku-5-5')
  expect(row?.description).toBe('review the diff')
})

test('every step of a main turn is kept on its row, in order', { options: { policy_mode: 'enforce' } }, async ($, on) => {
  const seen = seenPhases(on)
  const plan: { id: string; name: string; input: unknown }[][] = [
    [{ id: 'c1', name: 'Read', input: { file_path: '/r/calc.py' } }],
    [{ id: 'c2', name: 'Edit', input: { file_path: '/r/calc.py' } }],
    [{ id: 'c3', name: 'Bash', input: { command: 'pytest -q' } }],
    [],
  ]
  on('turn.step', async function* ($, e) {
    const toolUses = plan[e.index] ?? []
    yield { kind: 'text', index: 0, text: '' }
    return { turnId: e.turnId, index: e.index, answer: toolUses.length === 0 ? 'done' : '', toolUses, stopReason: 'end_turn', usage: null }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.turn.start({ turnId: 't1', text: 'fix calc' } as never)
  for (let index = 0; index < 4; index++)
    await drain($.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', effort: 'medium', messageCount: 1 }))
  const main = seen.value?.loops.find((l) => l.id === 'main')
  expect(main?.runs.map((r) => r.phase)).toEqual(['analysis', 'implementation', 'test', 'report'])
})

test("a subagent's steps between two of main's leave main's row whole", { options: { policy_mode: 'enforce' } }, async ($, on) => {
  const seen = seenPhases(on)
  answering(on, [{ id: 'c1', name: 'Read', input: { file_path: '/r/a.ts' } }])
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await drain($.turn.step({ turnId: 'm1', index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 1 }))
  await drain($.turn.step({ turnId: 'g1', index: 0, model: 'claude-haiku-5-5', effort: 'low', messageCount: 1, agentId: 'a9' }))
  await drain($.turn.step({ turnId: 'm1', index: 1, model: 'claude-opus-5-5', effort: 'medium', messageCount: 2 }))
  const main = seen.value?.loops.find((l) => l.id === 'main')
  expect(main?.runs).toEqual([{ phase: 'analysis', effort: 'medium', steps: 2, errors: 0, since: 1_000_000, reads: 2, escalated: 0 }])
  expect(seen.value?.turnId).toBe('m1')
})

test('enforce: a phase calibrated to high keeps a critical turn\'s loop at high in that phase', { options: { policy_mode: 'enforce' } }, async ($, on) => {
  seenPhases(on, { '/home/t/.claude/zetetic-insights/calibration.json': '{"version":1,"phases":{"analysis":"high"},"evidence":{}}' })
  const efforts: unknown[] = []
  on('turn.step', async function* ($, e) {
    efforts.push(e.effort)
    yield { kind: 'text', index: 0, text: '' }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ id: 'c', name: 'Read', input: { file_path: '/r/a.ts' } }], stopReason: 'tool_use', usage: null }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-fable-5-1', effort: 'high', messageCount: 1 }))
  await drain($.turn.step({ turnId: 't1', index: 1, model: 'claude-fable-5-1', effort: 'high', messageCount: 2 }))
  expect(efforts).toEqual(['high', 'high'])
})

// The stuck escalation, counted on the run its raised step landed in (PhaseRun.escalated): main reads a file at
// `first`, three of its tool calls fail, then main steps at `then`, and once more at `then` after that.
const stuckTurn = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], first: string, then: string) => {
  const seen = seenPhases(on)
  const efforts: unknown[] = []
  on('turn.step', async function* ($, e) {
    efforts.push(e.effort)
    yield { kind: 'text', index: 0, text: '' }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ id: `c${e.index}`, name: 'Read', input: { file_path: '/r/a.ts' } }], stopReason: 'tool_use', usage: null }
  })
  on('tool.call', () => ({ deny: 'no such file' }) as never)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: first, messageCount: 1 } as never))
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Read', file_path: '/r/missing.ts' } as never)
  await drain($.turn.step({ turnId: 't1', index: 1, model: 'claude-opus-5-5', effort: then, messageCount: 2 } as never))
  await drain($.turn.step({ turnId: 't1', index: 2, model: 'claude-opus-5-5', effort: then, messageCount: 3 } as never))
  return { seen, efforts, main: seen.value?.loops.find((l) => l.id === 'main') }
}

// Review of #25 round 3 (stuck decision contract) and #26 round 2 (A, C, D): the raised step merges into the run
// before it (same phase, same effort), so that run's `since` is earlier than the decision's `at`. The run carries it.
test('enforce: a stuck escalation that merges into the run before it is counted on that run', { options: { policy_mode: 'enforce' } }, async ($, on) => {
  const { seen, efforts, main } = await stuckTurn($, on, 'high', 'medium')
  expect(efforts).toEqual(['high', 'high', 'medium'])
  expect(seen.decisions?.filter((d) => d.kind === 'stuck')).toMatchObject([{ from: 'medium', to: 'high', applied: true }])
  expect(main?.runs).toEqual([
    { phase: 'analysis', effort: 'high', steps: 2, errors: 3, since: 1_000_000, reads: 2, escalated: 1 },
    { phase: 'analysis', effort: 'medium', steps: 1, errors: 0, since: 1_000_000, reads: 1, escalated: 0 },
  ])
})

// The session's own effort is the one the escalation reaches (Opus at high: the ladder's medium, raised to high): the
// step goes out as it came, no decision row is written, and the escalation still decided its rung.
test('enforce: an escalation back to the effort the step came with is counted, though no row is logged', { options: { policy_mode: 'enforce' } }, async ($, on) => {
  const { seen, efforts, main } = await stuckTurn($, on, 'high', 'high')
  expect(efforts).toEqual(['high', 'high', 'medium'])
  expect(seen.decisions?.filter((d) => d.kind === 'stuck')).toEqual([])
  expect(main?.runs.map((r) => [r.effort, r.steps, r.escalated])).toEqual([['high', 2, 1], ['medium', 1, 0]])
})

test('observe: the stuck escalation is logged, not sent, and no run counts it', { options: { policy_mode: 'observe' } }, async ($, on) => {
  const { seen, efforts, main } = await stuckTurn($, on, 'high', 'medium')
  expect(efforts).toEqual(['high', 'medium', 'medium'])
  expect(seen.decisions?.filter((d) => d.kind === 'stuck')).toMatchObject([{ from: 'medium', to: 'high', applied: false }])
  expect(main?.runs.map((r) => [r.effort, r.steps, r.escalated])).toEqual([['high', 1, 0], ['medium', 2, 0]])
})

test('enforce: the ladder stepping a loop down is not an escalation', { options: { policy_mode: 'enforce' } }, async ($, on) => {
  const seen = seenPhases(on)
  answering(on, [{ id: 'c1', name: 'Read', input: { file_path: '/r/a.ts' } }])
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 }))
  await drain($.turn.step({ turnId: 't1', index: 1, model: 'claude-opus-5-5', effort: 'high', messageCount: 2 }))
  expect(seen.decisions?.filter((d) => d.kind !== 'unread').map((d) => [d.kind, d.to, d.applied])).toEqual([['effort', 'medium', true]])
  expect(seen.value?.loops.find((l) => l.id === 'main')?.runs.map((r) => [r.effort, r.escalated])).toEqual([['high', 0], ['medium', 0]])
})
