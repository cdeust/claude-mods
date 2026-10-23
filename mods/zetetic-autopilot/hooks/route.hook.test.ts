import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Wiring tests: agent.spawn reads the agent's definition before it routes, and a subagent's steps
// keep the effort the engine sends them (the definition's).

const FABLE = 'claude-fable-5-1'
// The disk below uses POSIX-root fixtures; Windows adds its runner drive.
const rootedPath = (path: string): string => path.replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/)/, '')
const ZETETIC = '/c/zetetic/2.44.0'
const INSTALLED = JSON.stringify({ plugins: { 'zetetic-team-subagents@zetetic-marketplace': [{ installPath: ZETETIC }] } })
const FILES: Record<string, string> = {
  '/home/t/.claude/plugins/installed_plugins.json': INSTALLED,
  [`${ZETETIC}/agents/advisor.md`]: '---\nname: advisor\nmodel: fable\neffort: high\n---\n',
  [`${ZETETIC}/agents/memory-writer.md`]: '---\nname: memory-writer\nmodel: haiku\neffort: low\n---\n',
}

// What the stubbed disk holds beyond FILES, which paths fail with an I/O error although they exist,
// and the paths read: one object per test, so a test can change the disk between two spawns.
type Disk = { cwd: string; files: Record<string, string>; failing: Set<string>; reads: string[] }
const disk = (extra: Partial<Disk> = {}): Disk => ({ cwd: '/r', files: { ...FILES }, failing: new Set(), reads: [], ...extra })

type Seen = { spawned: (string | undefined)[]; efforts: unknown[]; policy?: { decisions: { kind: string; subject: string; to: string }[] } }

const stubs = (on: Parameters<TestBody>[1], seen: Seen, genius: 'absent' | 'throws' = 'absent', d: Disk = disk()) => {
  mock.clock(on, { now: 1_000_000 })
  on('session.start', () => ({ cwd: d.cwd }))
  on('session.cwd', () => ({ value: d.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0 } } as never }))
  on('session.model', () => ({ value: FABLE }))
  on('env.get', ($, e) => ({ value: ((e as { name?: string }).name === 'HOME' ? '/home/t' : undefined) as never }))
  on('fs.exists', ($, e) => ({ value: rootedPath(String((e as { path?: string }).path ?? '')) in d.files }))
  on('fs.read', ($, e) => {
    const path = rootedPath(String((e as { path?: string }).path ?? ''))
    d.reads.push(path)
    if (d.failing.has(path)) return { deny: 'EIO: i/o error' }
    const text = d.files[path]
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
  on('session.id', () => ({ value: 'sid-1' }))
  on('store.keys', () => ({ value: [] as never }))
  on('store.get', () => ({ value: undefined as never }))
  on('store.set', () => ({ value: undefined as never }))
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
  'enforce: under quota pressure a haiku memory-writer stays on haiku and a fable advisor stays on fable',
  { options: { policy_mode: 'enforce', quota_pressure_percent: 80 } },
  async ($, on) => {
    const seen: Seen = { spawned: [], efforts: [] }
    stubs(on, seen)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
    await $.session.measure(QUOTA)
    await $.agent.spawn(spawn('zetetic-team-subagents:memory-writer'))
    await $.agent.spawn(spawn('zetetic-team-subagents:advisor'))
    expect(seen.spawned).toEqual([undefined, undefined])
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

// Issue #11, case 2: a session started in a subdirectory finds the project's agents at the repository root.
test(
  'a project agent is found from a subdirectory of the repository, up to the repository root',
  { options: { policy_mode: 'enforce', quota_pressure_percent: 80 } },
  async ($, on) => {
    const seen: Seen = { spawned: [], efforts: [] }
    const d = disk({
      cwd: '/r/pkg/deep',
      files: { ...FILES, '/r/.git': '', '/r/.claude/agents/dispatch.md': '---\nname: dispatch\nmodel: haiku\n---\n' },
    })
    stubs(on, seen, 'absent', d)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: d.cwd })
    await $.session.measure(QUOTA)
    await $.agent.spawn(spawn('dispatch'))
    expect(seen.policy?.decisions.find((x) => x.kind === 'unread')).toBeUndefined()
    expect(seen.spawned).toEqual([undefined])
    expect(d.reads).toContain('/r/.claude/agents/dispatch.md')
  },
)

// Issue #11: the walk up from the working directory stops at the first folder holding a `.git`; a
// definition above that folder belongs to another project and is never read.
const DISPATCH = '---\nname: dispatch\nmodel: haiku\n---\n'
const noRead = (d: Disk, path: string) => expect(d.reads).not.toContain(path)

test(
  'the walk up stops at the repository root: a definition above it is never read',
  { options: { policy_mode: 'enforce', quota_pressure_percent: 80 } },
  async ($, on) => {
    const seen: Seen = { spawned: [], efforts: [] }
    const d = disk({ cwd: '/r/pkg', files: { ...FILES, '/r/.git': '', '/.claude/agents/dispatch.md': DISPATCH } })
    stubs(on, seen, 'absent', d)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: d.cwd })
    await $.session.measure(QUOTA)
    await $.agent.spawn(spawn('dispatch'))
    noRead(d, '/.claude/agents/dispatch.md')
    expect(seen.policy?.decisions.find((x) => x.kind === 'unread')?.to).toMatch(/^no file at /)
    const named = seen.policy?.decisions.find((x) => x.kind === 'unread')?.to.replace('no file at ', '').split(', ').map(rootedPath)
    expect(named).toEqual(['/r/pkg/.claude/agents/dispatch.md', '/r/.claude/agents/dispatch.md', '/home/t/.claude/agents/dispatch.md'])
  },
)

test(
  'with a definition at the repository root and one above it, only the root one is read',
  { options: { policy_mode: 'enforce', quota_pressure_percent: 80 } },
  async ($, on) => {
    const seen: Seen = { spawned: [], efforts: [] }
    const d = disk({
      cwd: '/r/pkg',
      files: { ...FILES, '/r/.git': '', '/r/.claude/agents/dispatch.md': DISPATCH, '/.claude/agents/dispatch.md': DISPATCH },
    })
    stubs(on, seen, 'absent', d)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: d.cwd })
    await $.session.measure(QUOTA)
    await $.agent.spawn(spawn('dispatch'))
    expect(d.reads).toContain('/r/.claude/agents/dispatch.md')
    noRead(d, '/.claude/agents/dispatch.md')
  },
)

test(
  'in a worktree (.git is a file) the walk stops at the worktree, never at the main checkout above',
  { options: { policy_mode: 'enforce', quota_pressure_percent: 80 } },
  async ($, on) => {
    const seen: Seen = { spawned: [], efforts: [] }
    const d = disk({
      cwd: '/r/wt/sub',
      files: { ...FILES, '/r/.git': '', '/r/wt/.git': 'gitdir: /r/.git/worktrees/wt', '/r/.claude/agents/dispatch.md': DISPATCH },
    })
    stubs(on, seen, 'absent', d)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: d.cwd })
    await $.session.measure(QUOTA)
    await $.agent.spawn(spawn('dispatch'))
    noRead(d, '/r/.claude/agents/dispatch.md')
    expect(seen.policy?.decisions.find((x) => x.kind === 'unread')?.to).toMatch(/^no file at /)
  },
)

test(
  'a plugin type no installed plugin provides is proven absent: remembered, the record read once, named once',
  { options: { policy_mode: 'enforce' } },
  async ($, on) => {
    const seen: Seen = { spawned: [], efforts: [] }
    const d = disk()
    stubs(on, seen, 'absent', d)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: d.cwd })
    await $.agent.spawn(spawn('nosuchplugin:ghost'))
    await $.agent.spawn(spawn('nosuchplugin:ghost'))
    expect(d.reads.filter((p) => p.endsWith('installed_plugins.json'))).toHaveLength(1)
    expect(seen.policy?.decisions.filter((x) => x.kind === 'unread' && x.to === 'no installed plugin provides it')).toHaveLength(1)
  },
)

// Issue #11, case 3: a read that fails is not "no such file"; the next spawn reads again.
test(
  'a definition that failed to read is read again at the next spawn, and a found one is read once',
  { options: { policy_mode: 'enforce', quota_pressure_percent: 80 } },
  async ($, on) => {
    const seen: Seen = { spawned: [], efforts: [] }
    const advisor = `${ZETETIC}/agents/advisor.md`
    const d = disk()
    d.failing.add(advisor)
    stubs(on, seen, 'absent', d)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: d.cwd })
    await $.session.measure(QUOTA)
    await $.agent.spawn(spawn('zetetic-team-subagents:advisor'))
    expect(seen.policy?.decisions.find((x) => x.kind === 'unread')?.to).toMatch(/EIO/)
    d.failing.delete(advisor)
    await $.agent.spawn(spawn('zetetic-team-subagents:advisor'))
    await $.agent.spawn(spawn('zetetic-team-subagents:advisor'))
    expect(d.reads.filter((p) => p === advisor)).toHaveLength(2)
    // the definition's fable stands under quota pressure: nothing is rewritten
    expect(seen.spawned.slice(1)).toEqual([undefined, undefined])
  },
)

test(
  'a definition whose file is absent is remembered as absent, and named once',
  { options: { policy_mode: 'enforce' } },
  async ($, on) => {
    const seen: Seen = { spawned: [], efforts: [] }
    const d = disk()
    stubs(on, seen, 'absent', d)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: d.cwd })
    await $.agent.spawn(spawn('zetetic-team-subagents:ghost'))
    await $.agent.spawn(spawn('zetetic-team-subagents:ghost'))
    expect(d.reads.filter((p) => p.endsWith('/ghost.md'))).toHaveLength(0)
    expect(seen.policy?.decisions.filter((x) => x.kind === 'unread' && x.to.startsWith('no file at'))).toHaveLength(1)
  },
)
