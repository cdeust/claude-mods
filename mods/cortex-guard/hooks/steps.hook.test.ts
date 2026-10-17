import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Round 3 of PR 30, through the engine: the refusal and the registration read one analysis of the command, so an
// add is registered where the refusal judged it, every add of a command is registered, and an add whose place is
// not known is told, never silent. The disk is a set of linked worktrees: `before` exist before the call, `makes`
// are those the call leaves (what real git created for the same command, measured in a scratch repo).
const SCRIPT = '/home/t/Developments/disk-hygiene/disk_hygiene.py'

type Seen = { toasts: string[]; registered: string[]; calls: number }

// A file system reads `a/b/../c` as `a/c`; the engine may hand the stub either spelling.
const folded = (path: string): string =>
  path.split('/').reduce<string[]>((kept, segment) => (segment === '..' ? kept.slice(0, -1) : [...kept, segment]), []).join('/')

const disk = (on: Parameters<TestBody>[1], how: { cwd: string; makes: string[]; call?: unknown; before?: string[] }): Seen => {
  const seen: Seen = { toasts: [], registered: [], calls: 0 }
  const worktrees = new Set((how.before ?? []).map(folded))
  mock.clock(on, { now: 1_000_000 })
  on('env.get', ($, e) => ({ value: ((e as { name?: string }).name === 'HOME' ? '/home/t' : undefined) as never }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.cwd', () => ({ value: how.cwd }))
  on('fs.stat', ($, e) => {
    if (e.path === SCRIPT) return { value: { kind: 'file', size: 1, mtimeMs: 0 } as never }
    if (worktrees.has(folded(e.path))) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: folded(e.path) } as never }
    return { deny: `ENOENT: no such file or directory, stat '${e.path}'` }
  })
  on('fs.read', ($, e) => {
    const dir = folded(e.path.replace(/\/\.git$/, ''))
    return worktrees.has(dir) ? { value: 'gitdir: /r/.git/worktrees/x\n' as never } : { deny: `ENOENT: open '${e.path}'` }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const argv = (e as { argv: string[] }).argv
    if (argv[1] === SCRIPT) seen.registered.push(argv[argv.indexOf('--path') + 1] ?? '')
    return { value: { exitCode: 0, stdout: 'Python 3.12.1', stderr: '' } as never }
  })
  on('tool.call', () => {
    seen.calls += 1
    for (const dir of how.makes) worktrees.add(folded(dir))
    return (how.call ?? { result: 'ran' }) as never
  })
  return seen
}

const FAILED = { result: 'exit 1', isError: true }

test('N5: every add of one command is registered, not the first alone', async ($, on) => {
  const a = '/r/.claude/worktrees/a'
  const b = '/r/.claude/worktrees/b'
  const seen = disk(on, { cwd: '/r', makes: [a, b] })
  const ran = await $.tool.call({ tool: 'Bash', command: `git worktree add -b a ${a} main && git worktree add -b b ${b} main` })
  expect(seen.registered).toEqual([a, b])
  expect(ran.context).toBeUndefined()
})

test('a git glued to its separator is registered where the shell was', async ($, on) => {
  const seen = disk(on, { cwd: '/elsewhere', makes: ['/r/.claude/worktrees/g'] })
  await $.tool.call({ tool: 'Bash', command: 'cd /r&&git worktree add ./.claude/worktrees/g' })
  expect(seen.registered).toEqual(['/r/.claude/worktrees/g'])
})

test('an add inside a quoted substitution is judged and registered', async ($, on) => {
  const seen = disk(on, { cwd: '/r', makes: ['/r/.claude/worktrees/s'] })
  await $.tool.call({ tool: 'Bash', command: 'echo "$( git worktree add /r/.claude/worktrees/s)"' })
  expect(seen.registered).toEqual(['/r/.claude/worktrees/s'])
})

test('the relative path refused on 2026-10-17 from the repo root is allowed and registered', async ($, on) => {
  const seen = disk(on, { cwd: '/r', makes: ['/r/.claude/worktrees/guard-r3'] })
  const ran = await $.tool.call({ tool: 'Bash', command: 'git worktree add -b fix/x .claude/worktrees/guard-r3 origin/fix/x' })
  expect(ran.deny).toBeUndefined()
  expect(seen.registered).toEqual(['/r/.claude/worktrees/guard-r3'])
})

// N4: a directory change spelled through a prefix is a directory change, and a call that failed after the add
// (the `&& false`) still registers what is on disk.
for (const lead of ['builtin cd sub', 'FOO=1 cd sub']) {
  test(`N4: ${lead} moves the shell, and the add after it is registered there`, async ($, on) => {
    const made = '/r/sub/../.claude/worktrees/w'
    const seen = disk(on, { cwd: '/r', makes: [made], call: FAILED })
    await $.tool.call({ tool: 'Bash', command: `${lead} && git worktree add ../.claude/worktrees/w && false` })
    expect(seen.registered).toEqual(['/r/.claude/worktrees/w'])
  })
}

// Measured on real git: under zsh `command cd sub` runs /usr/bin/cd in a child and the shell stays in /r (the
// worktree landed at /.claude/worktrees/w, one level above the repo); under bash it is the builtin and moves.
test('N4: command cd moves the shell in bash and not in zsh; the place is unknown and told, never silent', async ($, on) => {
  const seen = disk(on, { cwd: '/r', makes: ['/.claude/worktrees/w'], call: FAILED })
  const ran = await $.tool.call({ tool: 'Bash', command: 'command cd sub && git worktree add ../.claude/worktrees/w && false' })
  expect(seen.registered).toEqual([])
  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toMatch(/could not be resolved: the cd may run outside the shell \(command cd sub\)/)
  expect(ran.context?.[0]).toContain('NOT registered')
})

test('N4: env -C moves git alone; the place is unknown, and the user and Claude are told even when the call failed', async ($, on) => {
  const seen = disk(on, { cwd: '/r', makes: ['/r/sub/../.claude/worktrees/w'], call: FAILED })
  const ran = await $.tool.call({ tool: 'Bash', command: 'env -C sub git worktree add ../.claude/worktrees/w && false' })
  expect(seen.registered).toEqual([])
  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toMatch(/^worktree NOT registered \(the path \.\.\/\.claude\/worktrees\/w could not be resolved: .*env -C/)
  expect(ran.context?.[0]).toContain('NOT registered')
})

test('N2: an in-root mention cannot carry an outside add past the refusal', async ($, on) => {
  const seen = disk(on, { cwd: '/r', makes: ['/r/../out'] })
  const ran = await $.tool.call({ tool: 'Bash', command: 'echo "git worktree add ./.claude/worktrees/a" ; git worktree add -b b /r/../out' })
  expect(ran.deny).toMatch(/worktree-inside-repo/)
  expect(seen.calls).toBe(0)
  expect(seen.registered).toEqual([])
})

test('N1: an add piped into a shell is refused before it runs', async ($, on) => {
  const seen = disk(on, { cwd: '/r', makes: ['/r/.claude/worktrees/a'] })
  const ran = await $.tool.call({ tool: 'Bash', command: "echo 'git worktree add ./.claude/worktrees/a' | sh" })
  expect(ran.deny).toMatch(/worktree-inside-repo/)
  expect(seen.calls).toBe(0)
})

test('a mention no shell runs is neither refused, registered nor reported', async ($, on) => {
  const seen = disk(on, { cwd: '/r', makes: [] })
  const ran = await $.tool.call({ tool: 'Bash', command: "git commit -m \"$(cat <<'EOF'\nfix: git worktree add ./.claude/worktrees/x is registered\nEOF\n)\"" })
  expect(ran.deny).toBeUndefined()
  expect(seen.toasts).toEqual([])
  expect(ran.context).toBeUndefined()
})
