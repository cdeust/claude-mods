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

// The offload: what the fake session holds (its id, its transcript), what is written where, every
// process the mod started (none may be), and the rows it logged.
const SESSION = 'sess-1'
const TRANSCRIPT = `/home/t/.claude/projects/-r/${SESSION}.jsonl`
const DIR = `/home/t/.claude/projects/-r/${SESSION}/tool-results`

type Disk = { written: Record<string, string>; processes: string[]; refuse?: string; rows: { kind: string; subject: string; to: string; applied: boolean }[] }

const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))

  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const diskOf = (on: Parameters<TestBody>[1], refuse?: string): Disk => {
  const disk: Disk = { written: {}, processes: [], refuse, rows: [] }
  on('session.id', () => ({ value: SESSION }))
  on('classic.SessionStart', () => ({}) as never)
  on('fs.exists', ($, e) => ({ value: String((e as { path?: string }).path) in disk.written }))
  on('fs.write', ($, e) => {
    if (disk.refuse !== undefined) return { deny: disk.refuse }
    const { path, text } = e as unknown as { path: string; text: string }
    disk.written[path] = text

    return { value: undefined as never }
  })
  on('process.run', ($, e) => {
    disk.processes.push(String((e as { argv?: unknown }).argv))

    return { deny: 'no process in this test' }
  })
  on('state.set', ($, e, next) => {
    const v = (e as unknown as { key?: string; value?: { decisions?: Disk['rows'] } })
    if (v.key === 'policy') disk.rows = v.value?.decisions ?? []

    return next(e)
  })

  return disk
}

const toolRow = (tool: string, content: unknown, id = 'toolu_01') =>
  ({
    door: 'tool-result',
    origin: { kind: 'tool', tool },
    uuid: `u-${id}`,
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  }) as never

const start = async ($: Parameters<TestBody>[0], transcript = TRANSCRIPT) => {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.classic.SessionStart({ source: 'startup', session_id: SESSION, transcript_path: transcript })
}

const storedOf = (on: Parameters<TestBody>[1]): unknown[] => {
  const stored: unknown[] = []
  on('session.append', ($, e, next) => {
    stored.push((e.message.content[0] as { content?: unknown }).content)

    return next(e)
  })

  return stored
}

const ENFORCE = { options: { policy_mode: 'enforce', offload_threshold_chars: 1000, offload_preview_chars: 200 } }
const LONG = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n')

test('enforce: a long Bash result is written whole to the session directory; the model gets preview, path and size', ENFORCE, async ($, on) => {
  stubs(on, [])
  const disk = diskOf(on)
  const stored = storedOf(on)
  await start($)
  await $.session.append(toolRow('Bash', LONG))
  const path = `${DIR}/autopilot-toolu_01.txt`
  expect(Object.keys(disk.written)).toEqual([path])
  expect(await sha256(disk.written[path] ?? '')).toBe(await sha256(LONG))
  const seen = String(stored[0])
  expect(seen).toContain(`Full output saved to: ${path}`)
  expect(seen).toContain('Read or grep the file for the rest')
  expect(seen).toContain(LONG.slice(0, 100))
  expect(seen.length < 700).toBe(true)
  expect(seen).not.toContain('cut')
  expect(seen).not.toContain('truncated')
  expect(disk.rows.at(-1)).toMatchObject({ kind: 'offload', subject: 'Bash', applied: true })
  expect(disk.processes).toEqual([])
})

test('enforce: a result in text blocks is offloaded the same way, whole', ENFORCE, async ($, on) => {
  stubs(on, [])
  const disk = diskOf(on)
  const stored = storedOf(on)
  await start($)
  await $.session.append(toolRow('Grep', [{ type: 'text', text: LONG }], 'toolu_02'))
  const path = `${DIR}/autopilot-toolu_02.txt`
  expect(disk.written[path] === LONG).toBe(true)
  const blocks = stored[0] as { type: string; text: string }[]
  expect(blocks[0]?.type).toBe('text')
  expect(blocks[0]?.text).toContain(path)
})

test('enforce: a result within the threshold is stored as it is and nothing is written', ENFORCE, async ($, on) => {
  stubs(on, [])
  const disk = diskOf(on)
  const stored = storedOf(on)
  await start($)
  await $.session.append(toolRow('Bash', 'x'.repeat(1000)))
  expect(stored[0]).toBe('x'.repeat(1000))
  expect(disk.written).toEqual({})
  expect(disk.rows.filter((r) => r.kind === 'offload')).toEqual([])
})

test("enforce: the engine's own pointer is not wrapped again, and a tool outside the list is not touched", ENFORCE, async ($, on) => {
  stubs(on, [])
  const disk = diskOf(on)
  const stored = storedOf(on)
  await start($)
  const native = `<persisted-output>\nOutput too large (49.2KB). Full output saved to: /p/native.txt\n\nPreview (first 2KB):\n${'y'.repeat(3000)}`
  await $.session.append(toolRow('Bash', native))
  expect(stored[0]).toBe(native)
  await $.session.append(toolRow('mcp__other__tool', LONG, 'toolu_03'))
  expect(stored[1]).toBe(LONG)
  expect(disk.written).toEqual({})
})

test('observe: a long result is stored whole, nothing is written, the decision is logged as observed', { options: { policy_mode: 'observe', offload_threshold_chars: 1000 } }, async ($, on) => {
  stubs(on, [])
  const disk = diskOf(on)
  const stored = storedOf(on)
  await start($)
  await $.session.append(toolRow('Bash', LONG))
  expect(stored[0]).toBe(LONG)
  expect(disk.written).toEqual({})
  expect(disk.rows.at(-1)).toMatchObject({ kind: 'offload', applied: false })
})

test('retention: the mod only writes, inside the current session directory, and starts no process', ENFORCE, async ($, on) => {
  stubs(on, [])
  const disk = diskOf(on)
  await start($)
  await $.session.append(toolRow('Bash', LONG, 'toolu_a'))
  await $.session.append(toolRow('Glob', LONG, 'toolu_b'))
  await $.session.append(toolRow('WebFetch', LONG, 'toolu_c'))
  expect(Object.keys(disk.written).sort()).toEqual(['a', 'b', 'c'].map((k) => `${DIR}/autopilot-toolu_${k}.txt`))
  expect(Object.keys(disk.written).every((p) => p.startsWith(`${DIR}/`))).toBe(true)
  expect(disk.processes).toEqual([])
})

test('a transcript that is not this session\'s, or none, leaves the result whole and says why once', ENFORCE, async ($, on) => {
  stubs(on, [])
  const disk = diskOf(on)
  const stored = storedOf(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.session.append(toolRow('Bash', LONG))
  await start($, '/home/t/.claude/projects/-r/another-session.jsonl')
  await $.session.append(toolRow('Bash', LONG, 'toolu_02'))
  expect(stored).toEqual([LONG, LONG])
  expect(disk.written).toEqual({})
  expect(disk.rows.filter((r) => r.subject === 'tool-results directory').length).toBe(1)
})

test('a write the engine refuses leaves the result whole and names the refusal', ENFORCE, async ($, on) => {
  stubs(on, [])
  const disk = diskOf(on, 'EACCES')
  const stored = storedOf(on)
  await start($)
  await $.session.append(toolRow('Bash', LONG))
  expect(stored[0]).toBe(LONG)
  expect(disk.rows.some((r) => r.subject === 'Bash result' && r.to.includes('stays whole') && r.to.includes('EACCES'))).toBe(true)
})

test('an option that is not a positive whole number is named and the default stands', { options: { policy_mode: 'enforce', offload_threshold_chars: 0 } }, async ($, on) => {
  stubs(on, [])
  const disk = diskOf(on)
  const stored = storedOf(on)
  await start($)
  expect(disk.rows.some((r) => r.subject === 'offload option' && r.to.includes('using 30000'))).toBe(true)
  await $.session.append(toolRow('Bash', LONG))
  expect(stored[0]).toBe(LONG) // 12 000 characters: within the default threshold
})

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
    // main's first step of turn 't' makes it the current main turn the grade is bound to
    await drain($.turn.step({ ...STEP, index: 0, effort: 'high' }))
    const spawn = (model: string | undefined) =>
      ({
        tool_use_id: 'a1',
        prompt: 'DESIGN\ntask: x\n\nlook around',
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

test(
  'enforce: a grade bound to an earlier main turn does not route the next turn\'s subagents',
  { options: { policy_mode: 'enforce' } },
  async ($, on) => {
    stubs(on, [], { turnId: 't', taskClass: 'routine', effort: 'low' })
    let spawned: string | undefined
    on('agent.spawn', ($, e) => {
      spawned = e.model
      return { model: e.model ?? 'inherit' }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
    await drain($.turn.step({ ...STEP, turnId: 'later', index: 0, effort: 'high' }))
    await $.agent.spawn({
      tool_use_id: 'a1',
      prompt: 'DESIGN\ntask: x\n\nlook around',
      description: 'explore',
      subagentType: 'Explore',
      provider: { kind: 'model', model: 'claude-fable-5-1' },
      parentModel: 'claude-fable-5-1',
    } as never)
    expect(spawned).toBe('sonnet')
  },
)
