import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Wiring tests: the policy hooks on turn.step, agent.spawn and session.append, observed then enforced.

const STEP = { turnId: 't', model: 'claude-fable-5-1', messageCount: 3 } as const

const stepStub = (on: Parameters<TestBody>[1], seen: { effort?: unknown }[]) => {
  mock.clock(on, { now: 1_000_000 })
  on('turn.step', async function* ($, e) {
    seen.push({ effort: e.effort })
    yield { kind: 'text', index: 0, text: 'ok' }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    }
  })
}

const drain = async (stream: AsyncGenerator<unknown, unknown>) => {
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
  return step.value
}

test('observe: the ladder is logged and the request goes out unchanged', async ($, on) => {
  const seen: { effort?: unknown }[] = []
  stepStub(on, seen)
  await drain($.turn.step({ ...STEP, index: 0, effort: 'high' }))
  await drain($.turn.step({ ...STEP, index: 2, effort: 'high' }))
  expect(seen.map((s) => s.effort)).toEqual(['high', 'high'])
})

test(
  'enforce: the loop request goes out at medium, the first one untouched',
  { options: { policy_mode: 'enforce' } },
  async ($, on) => {
    const seen: { effort?: unknown }[] = []
    stepStub(on, seen)
    on('session.start', () => ({ cwd: '/r' }))
    on('session.repo', () => ({ value: { root: '/r' } as never }))
    on('session.usage', () => ({
      value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0 } } as never,
    }))
    on('session.model', () => ({ value: 'claude-fable-5-1' }))
    on('fs.read', () => ({ deny: 'absent' }))
    on('command.register', () => ({ value: undefined } as never))
    on('mcp.call', () => ({ deny: 'no server in a test' }))
    on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'no git' } as never }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
    await drain($.turn.step({ ...STEP, index: 0, effort: 'high' }))
    await drain($.turn.step({ ...STEP, index: 2, effort: 'high' }))
    expect(seen.map((s) => s.effort)).toEqual(['high', 'medium'])
  },
)

test('a long Bash result is left whole under observe', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  let stored = ''
  on('session.append', ($, e, next) => {
    const block = e.message.content[0] as { content?: string }
    stored = block.content ?? ''
    return next(e)
  })
  const long = 'x'.repeat(20000)
  await $.session.append({
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Bash' },
    uuid: 'u1',
    message: {
      type: 'user',
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c1', content: long }],
    },
  } as never)
  expect(stored.length).toBe(20000)
})

const startStubs = (on: Parameters<TestBody>[1]) => {
  mock.clock(on, { now: 1_000_000 })
  on('session.start', () => ({ cwd: '/r' }))
  on('session.repo', () => ({ value: { root: '/r' } as never }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0 } } as never,
  }))
  on('session.model', () => ({ value: 'claude-fable-5-1' }))
  on('fs.read', () => ({ deny: 'absent' }))
  on('command.register', () => ({ value: undefined } as never))
  on('mcp.call', () => ({ deny: 'no server in a test' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'no git' } as never }))
}

test(
  'enforce: a long Bash result is cut before it is stored, as a string or as text blocks',
  { options: { policy_mode: 'enforce', result_cap_chars: 1000 } },
  async ($, on) => {
    startStubs(on)
    const stored: unknown[] = []
    on('session.append', ($, e, next) => {
      stored.push((e.message.content[0] as { content?: unknown }).content)
      return next(e)
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
    const long = 'x'.repeat(5000)
    const row = (content: unknown) =>
      ({
        door: 'tool-result',
        origin: { kind: 'tool', tool: 'Bash' },
        uuid: 'u',
        message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content }] },
      }) as never
    await $.session.append(row(long))
    await $.session.append(row([{ type: 'text', text: long }]))
    expect(typeof stored[0]).toBe('string')
    expect(String(stored[0])).toContain('cortex-cockpit cut')
    expect(String(stored[0]).length < 2000).toBe(true)
    const blocks = stored[1] as { type: string; text: string }[]
    expect(blocks[0]?.type).toBe('text')
    expect(blocks[0]?.text).toContain('cortex-cockpit cut')
  },
)

test(
  'enforce: under quota pressure an opus subagent is spawned on sonnet',
  { options: { policy_mode: 'enforce', quota_pressure_percent: 50 } },
  async ($, on) => {
    startStubs(on)
    on('session.measure', ($, e) => ({ changed: e.changed }))
    let spawned: string | undefined
    on('agent.spawn', ($, e) => {
      spawned = e.model
      return { model: e.model ?? 'inherit' }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
    await $.session.measure({
      context: { window: 200000, tokens: 1000, percent: 1 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 60 }],
      changed: ['rateLimits'],
    } as never)
    await $.agent.spawn({
      tool_use_id: 'a1',
      prompt: 'look around',
      description: 'explore',
      subagentType: 'Explore',
      provider: { kind: 'model', model: 'claude-fable-5-1' },
      model: 'opus',
      parentModel: 'claude-fable-5-1',
    } as never)
    expect(spawned).toBe('sonnet')
  },
)
