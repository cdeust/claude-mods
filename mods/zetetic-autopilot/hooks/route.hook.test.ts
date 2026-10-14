import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Wiring tests: agent.spawn reads the agent's definition before it routes, and a subagent's steps
// keep the effort the engine sends them (the definition's).

const FABLE = 'claude-fable-5-1'
const ZETETIC = '/c/zetetic/2.44.0'
const INSTALLED = JSON.stringify({ plugins: { 'zetetic-team-subagents@zetetic-marketplace': [{ installPath: ZETETIC }] } })
const FILES: Record<string, string> = {
  '/home/t/.claude/plugins/installed_plugins.json': INSTALLED,
  [`${ZETETIC}/agents/advisor.md`]: '---\nname: advisor\nmodel: fable\neffort: high\n---\n',
  [`${ZETETIC}/agents/memory-writer.md`]: '---\nname: memory-writer\nmodel: haiku\neffort: low\n---\n',
}

type Seen = { spawned: (string | undefined)[]; efforts: unknown[]; policy?: { decisions: { kind: string; subject: string; to: string }[] } }

const stubs = (on: Parameters<TestBody>[1], seen: Seen, genius: 'absent' | 'throws' = 'absent') => {
  mock.clock(on, { now: 1_000_000 })
  on('session.start', () => ({ cwd: '/r' }))
  on('session.cwd', () => ({ value: '/r' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0 } } as never }))
  on('session.model', () => ({ value: FABLE }))
  on('env.get', ($, e) => ({ value: ((e as { name?: string }).name === 'HOME' ? '/home/t' : undefined) as never }))
  on('fs.read', ($, e) => {
    const text = FILES[String((e as { path?: string }).path ?? '')]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('state.get', ($, e, next) => {
    if ((e as { plugin?: string }).plugin !== 'zetetic-genius') return next(e)
    if (genius === 'throws') return { deny: 'state store offline' }
    return { value: { value: undefined, version: 0 } as never }
  })
  on('state.set', ($, e, next) => {
    if ((e as { key?: string }).key === 'policy') seen.policy = (e as unknown as { value: Seen['policy'] }).value
    return next(e)
  })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('agent.spawn', ($, e) => {
    seen.spawned.push(e.model)
    return { model: e.model ?? 'inherit' }
  })
  on('turn.step', async function* ($, e) {
    seen.efforts.push(e.effort)
    yield { kind: 'text', index: 0, text: 'ok' }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
}

const spawn = (subagentType: string) =>
  ({
    tool_use_id: 'a1',
    prompt: 'p',
    description: 'd',
    subagentType,
    provider: { kind: 'model', model: FABLE },
    parentModel: FABLE,
  }) as never

const QUOTA = { context: { window: 200000, tokens: 1000, percent: 1 }, rateLimits: [{ kind: 'five_hour', percentUsed: 90 }], changed: ['rateLimits'] } as never

const drain = async (stream: AsyncGenerator<unknown, unknown>) => {
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
}

test(
  'enforce: an advisor defined on fable keeps fable under a fable parent',
  { options: { policy_mode: 'enforce' } },
  async ($, on) => {
    const seen: Seen = { spawned: [], efforts: [] }
    stubs(on, seen)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
    await $.agent.spawn(spawn('zetetic-team-subagents:advisor'))
    expect(seen.spawned).toEqual([undefined])
  },
)

test(
  'enforce: under quota pressure a haiku memory-writer stays on haiku',
  { options: { policy_mode: 'enforce', quota_pressure_percent: 80 } },
  async ($, on) => {
    const seen: Seen = { spawned: [], efforts: [] }
    stubs(on, seen)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
    await $.session.measure(QUOTA)
    await $.agent.spawn(spawn('zetetic-team-subagents:memory-writer'))
    await $.agent.spawn(spawn('zetetic-team-subagents:advisor'))
    expect(seen.spawned).toEqual([undefined, 'sonnet'])
  },
)

test(
  'enforce: a definition that cannot be found routes nothing and says why',
  { options: { policy_mode: 'enforce', quota_pressure_percent: 80 } },
  async ($, on) => {
    const seen: Seen = { spawned: [], efforts: [] }
    stubs(on, seen)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
    await $.session.measure(QUOTA)
    await $.agent.spawn(spawn('zetetic-team-subagents:ghost'))
    expect(seen.spawned).toEqual([undefined])
    const row = seen.policy?.decisions.find((d) => d.kind === 'unread')
    expect(row?.subject).toBe('zetetic-team-subagents:ghost definition')
    expect(row?.to).toMatch(/no file at \/c\/zetetic\/2\.44\.0\/agents\/ghost\.md/)
  },
)

test(
  "enforce: a subagent's tool loop keeps its definition's high effort",
  { options: { policy_mode: 'enforce' } },
  async ($, on) => {
    const seen: Seen = { spawned: [], efforts: [] }
    stubs(on, seen)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
    const step = (index: number) => ({ turnId: 't', index, model: 'claude-opus-5-5', effort: 'high' as const, messageCount: 3, agentId: 'a1' })
    await drain($.turn.step(step(0)))
    await drain($.turn.step(step(3)))
    expect(seen.efforts).toEqual(['high', 'high'])
  },
)

test(
  "a genius state that cannot be read is a named row, and the turn goes on without a grade",
  { options: { policy_mode: 'enforce' } },
  async ($, on) => {
    const seen: Seen = { spawned: [], efforts: [] }
    stubs(on, seen, 'throws')
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
    await drain($.turn.step({ turnId: 't', index: 0, model: FABLE, effort: 'high', messageCount: 1 }))
    expect(seen.efforts).toEqual(['high'])
    const row = seen.policy?.decisions.find((d) => d.kind === 'unread')
    expect(row?.subject).toBe('zetetic-genius state')
    expect(row?.to).toMatch(/unreadable: .*state store offline/)
  },
)
