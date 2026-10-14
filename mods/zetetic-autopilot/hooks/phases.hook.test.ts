import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { PhasesState } from '../types'

// Wiring tests: the phases row of main and of a subagent, filled from the steps' results.

const seenPhases = (on: Parameters<TestBody>[1], files: Record<string, string> = {}): { value?: PhasesState } => {
  const seen: { value?: PhasesState } = {}
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
  expect(main?.runs).toEqual([{ phase: 'analysis', effort: 'medium', steps: 2, errors: 0, since: 1_000_000 }])
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
