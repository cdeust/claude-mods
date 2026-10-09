import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Wiring tests: the policy hooks on turn.step, agent.spawn and session.append, observed then
// enforced, with the genius grade read from the dependency's state.

const STEP = { turnId: 't', model: 'claude-fable-5-1', messageCount: 3 } as const

type Grade = { turnId: string | null; taskClass: string; effort: string } | null

// What the fake machine holds for the thresholds file: its text, or the refusal; the environment by
// name (HOME alone by default); every path read.
type World = { env?: Record<string, string>; thresholds?: string | { deny: string }; reads?: string[] }

const stubs = (on: Parameters<TestBody>[1], seen: { effort?: unknown }[], grade: Grade = null, world: World = {}) => {
  mock.clock(on, { now: 1_000_000 })
  on('session.start', () => ({ cwd: '/r' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0 } } as never,
  }))
  on('session.model', () => ({ value: 'claude-fable-5-1' }))
  const vars = world.env ?? { HOME: '/home/t' }
  on('env.get', ($, e) => ({ value: vars[String((e as { name?: string }).name ?? '')] as never }))
  on('fs.read', ($, e) => {
    world.reads?.push(String((e as { path?: string }).path ?? ''))
    const file = world.thresholds ?? { deny: 'absent' }

    return typeof file === 'string' ? { value: file } : file
  })
  // Only the dependency's state is stubbed; the mod's own values go to the real store beneath.
  on('state.get', ($, e, next) =>
    (e as { plugin?: string }).plugin === 'zetetic-genius'
      ? { value: { value: grade === null ? undefined : { classified: grade }, version: 1 } as never }
      : next(e),
  )
  on('turn.step', async function* ($, e) {
    seen.push({ effort: e.effort })
    yield { kind: 'text', index: 0, text: 'ok' }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
}

const drain = async (stream: AsyncGenerator<unknown, unknown>) => {
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
  return step.value
}

test(
  'observe: the ladder is logged and the request goes out unchanged',
  { options: { policy_mode: 'observe' } },
  async ($, on) => {
  const seen: { effort?: unknown }[] = []
  stubs(on, seen)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await drain($.turn.step({ ...STEP, index: 0, effort: 'high' }))
  await drain($.turn.step({ ...STEP, index: 2, effort: 'high' }))
  expect(seen.map((s) => s.effort)).toEqual(['high', 'high'])
})

test(
  'enforce: the loop request goes out at medium, the first one untouched',
  { options: { policy_mode: 'enforce' } },
  async ($, on) => {
    const seen: { effort?: unknown }[] = []
    stubs(on, seen)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
    await drain($.turn.step({ ...STEP, index: 0, effort: 'high' }))
    await drain($.turn.step({ ...STEP, index: 2, effort: 'high' }))
    expect(seen.map((s) => s.effort)).toEqual(['high', 'medium'])
  },
)

test(
  'enforce: a routine grade bound to the turn runs the whole turn at low',
  { options: { policy_mode: 'enforce' } },
  async ($, on) => {
    const seen: { effort?: unknown }[] = []
    stubs(on, seen, { turnId: 't', taskClass: 'routine', effort: 'low' })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
    await drain($.turn.step({ ...STEP, index: 0, effort: 'high' }))
    await drain($.turn.step({ ...STEP, index: 1, effort: 'high' }))
    expect(seen.map((s) => s.effort)).toEqual(['low', 'low'])
  },
)

test(
  'enforce: a grade bound to another turn does not apply',
  { options: { policy_mode: 'enforce' } },
  async ($, on) => {
    const seen: { effort?: unknown }[] = []
    stubs(on, seen, { turnId: 'other', taskClass: 'routine', effort: 'low' })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
    await drain($.turn.step({ ...STEP, index: 0, effort: 'high' }))
    expect(seen.map((s) => s.effort)).toEqual(['high'])
  },
)

test(
  'a long Bash result is left whole under observe',
  { options: { policy_mode: 'observe' } },
  async ($, on) => {
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
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: long }] },
  } as never)
  expect(stored.length).toBe(20000)
})

test(
  'enforce: a long Bash result is cut before it is stored, as a string or as text blocks',
  { options: { policy_mode: 'enforce', result_cap_chars: 1000 } },
  async ($, on) => {
    stubs(on, [])
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
    expect(String(stored[0])).toContain('zetetic-autopilot cut')
    expect(String(stored[0]).length < 2000).toBe(true)
    const blocks = stored[1] as { type: string; text: string }[]
    expect(blocks[0]?.type).toBe('text')
    expect(blocks[0]?.text).toContain('zetetic-autopilot cut')
  },
)

test(
  'enforce: under quota pressure an opus subagent is spawned on sonnet; a routine Explore goes to haiku',
  { options: { policy_mode: 'enforce', quota_pressure_percent: 50 } },
  async ($, on) => {
    stubs(on, [], { turnId: 't', taskClass: 'routine', effort: 'low' })
    on('session.measure', ($, e) => ({ changed: e.changed }))
    let spawned: string | undefined
    on('agent.spawn', ($, e) => {
      spawned = e.model
      return { model: e.model ?? 'inherit' }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
    const spawn = (model: string | undefined) =>
      ({
        tool_use_id: 'a1',
        prompt: 'look around',
        description: 'explore',
        subagentType: 'Explore',
        provider: { kind: 'model', model: 'claude-fable-5-1' },
        model,
        parentModel: 'claude-fable-5-1',
      }) as never
    await $.agent.spawn(spawn(undefined))
    expect(spawned).toBe('haiku')
    await $.session.measure({
      context: { window: 200000, tokens: 1000, percent: 1 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 60 }],
      changed: ['rateLimits'],
    } as never)
    await $.agent.spawn(spawn('opus'))
    expect(spawned).toBe('sonnet')
  },
)

const MEASURE = { context: { window: 200000, tokens: 1000, percent: 1 }, rateLimits: [], changed: ['context'] } as never
const THRESHOLDS = JSON.stringify({ default: { warn: 150000, hard: 190000 } })
// The context health the mod wrote, read off the state.set it made (the test cannot read another
// plugin's atom back directly).
const written = (on: Parameters<TestBody>[1]): { context?: { thresholdsSource: string; hard: number | null } } => {
  const seen: { context?: { thresholdsSource: string; hard: number | null } } = {}
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('state.set', ($, e, next) => {
    if ((e as { key?: string }).key === 'context') seen.context = (e as unknown as { value: typeof seen.context }).value
    return next(e)
  })
  return seen
}

test('the thresholds file is read under CLAUDE_CONFIG_DIR when it is set, not under HOME', async ($, on) => {
  const reads: string[] = []
  const seen = written(on)
  stubs(on, [], null, { env: { HOME: '/home/t', CLAUDE_CONFIG_DIR: '/work/cfg' }, thresholds: THRESHOLDS, reads })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.session.measure(MEASURE)
  expect([...new Set(reads)]).toEqual(['/work/cfg/ctxguard-thresholds.json'])
  expect(seen.context?.thresholdsSource).toBe('~/.claude/ctxguard-thresholds.json')
  expect(seen.context?.hard).toBe(190000)
})

test('a thresholds file that is not JSON shows that as its source, not as a missing match', async ($, on) => {
  const seen = written(on)
  stubs(on, [], null, { thresholds: '{truncated' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.session.measure(MEASURE)
  expect(seen.context?.thresholdsSource).toMatch(/ctxguard-thresholds\.json unreadable: ctxguard-thresholds\.json is not valid JSON/)
  expect(seen.context?.hard).toBe(null)
})

test('a refused thresholds file shows the refusal as its source', async ($, on) => {
  const seen = written(on)
  stubs(on, [], null, { thresholds: { deny: 'EACCES: permission denied' } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.session.measure(MEASURE)
  expect(seen.context?.thresholdsSource).toMatch(/unreadable: .*EACCES: permission denied/)
})

test('with no home to place the thresholds file the source says so', async ($, on) => {
  const seen = written(on)
  stubs(on, [], null, { env: {}, thresholds: THRESHOLDS })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.session.measure(MEASURE)
  expect(seen.context?.thresholdsSource).toMatch(/unreadable: ~\/\.claude\/ctxguard-thresholds\.json has no place: neither HOME nor USERPROFILE is set/)
})
