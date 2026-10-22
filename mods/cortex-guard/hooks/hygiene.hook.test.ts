import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { worktreeAddPath } from './guard'

// The registration of a worktree through the hygiene script, on a machine that is not the
// owner's: the script's place is computed from HOME, a missing file is said once, a refusal from
// the machine is shown. Registration runs after the call; each test waits on
// the toast it produces, the event that ends it. The call itself waits for the registration, so that
// a failure can be told to Claude in the call's result (the audience tests at the end).

const SCRIPT = '/home/t/Developments/disk-hygiene/disk_hygiene.py'
const ADD = { tool: 'Bash', command: 'git worktree add -b f /r/.claude/worktrees/f main' } as const

// `lib` names no DOM, so the timer is reached through the global object.
const later = (globalThis as unknown as { setTimeout: (run: () => void, ms: number) => unknown }).setTimeout

type Seen = { toasts: string[]; argvs: string[][]; stats: string[]; nextToast: () => Promise<string> }

// The disk the mod looks at: a worktree is a directory whose `.git` is a file naming
// `<repo>/.git/worktrees/<name>` (git-worktree(1), DETAILS). `before` are worktrees already on disk; `makes`
// are those the call leaves on disk, by default the absolute path the add names (the add ran and created
// it); `[]` is a call that created nothing. `cwd` is the session's directory. `gitfile` is what the `.git` file of
// each of them says (a linked worktree's by default).
type How = { call?: unknown; before?: string[]; makes?: string[]; cwd?: string; gitfile?: string; remakes?: string[] }

const nameOf = (dir: string): string => dir.slice(dir.lastIndexOf('/') + 1)

// `home` answers HOME alone; the other variables the mod asks for are unset.
const stubs = (on: Parameters<TestBody>[1], home: string | undefined | { deny: string }, scriptStat: unknown, how: How = {}): Seen => {
  const seen: Seen = { toasts: [], argvs: [], stats: [], nextToast: () => Promise.resolve('') }
  const worktrees = new Set(how.before ?? [])
  const born = new Map<string, number>()
  let waiting: ((text: string) => void) | undefined
  seen.nextToast = () => new Promise((resolve) => (waiting = resolve))
  mock.clock(on, { now: 1_000_000 })
  on('env.get', ($, e) =>
    typeof home === 'object' ? home : { value: ((e as { name?: string }).name === 'HOME' ? home : undefined) as never },
  )
  on('session.id', () => ({ value: 'test-session' }))
  on('session.cwd', () => ({ value: how.cwd ?? '/r' }))
  on('fs.stat', ($, e) => {
    seen.stats.push(e.path)
    if (e.path.endsWith('.py')) return scriptStat as never
    if (e.path.endsWith('/.git') && worktrees.has(e.path.replace(/\/\.git$/, '')))
      return { value: { kind: 'file', size: 1, mtimeMs: born.get(e.path.replace(/\/\.git$/, '')) ?? 0, isLink: false, realPath: e.path } as never }
    if (worktrees.has(e.path)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } as never }
    return { deny: `ENOENT: no such file or directory, stat '${e.path}'` }
  })
  on('fs.read', ($, e) => {
    const dir = e.path.replace(/\/\.git$/, '')
    return e.path.endsWith('/.git') && worktrees.has(dir)
      ? { value: (how.gitfile ?? `gitdir: /r/.git/worktrees/${nameOf(dir)}\n`) as never }
      : { deny: `ENOENT: no such file or directory, open '${e.path}'` }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    waiting?.(e.text)
    return { value: undefined }
  })
  on('tool.call', ($, e) => {
    const named = worktreeAddPath(String((e as { command?: string }).command ?? ''))
    for (const dir of how.makes ?? (named?.startsWith('/') ? [named] : [])) worktrees.add(dir)
    // A worktree removed and added again by the call: the same place and text, a newer `.git` file.
    for (const dir of how.remakes ?? []) born.set(dir, 1)
    return (how.call ?? { result: 'ran' }) as never
  })
  return seen
}

test('the default script is placed under the running user home, and a missing file is said once', async ($, on) => {
  const seen = stubs(on, '/home/t', { deny: "ENOENT: no such file or directory, stat '/home/t/Developments/disk-hygiene/disk_hygiene.py'" })
  on('process.run', ($$, e) => {
    seen.argvs.push((e as { argv: string[] }).argv)
    return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
  })
  const first = seen.nextToast()
  expect((await $.tool.call({ ...ADD })).result).toBe('ran')
  expect(await first).toMatch(
    /^hygiene script not found at \/home\/t\/Developments\/disk-hygiene\/disk_hygiene\.py; worktrees are not registered \(.*ENOENT/,
  )
  // A second worktree: the script is not looked for again and nothing is toasted again. Every
  // step of the registration is an already-resolved promise here, so one turn of the event loop
  // lets a registration that did run reach its toast (a yield, not a wait on the clock).
  expect((await $.tool.call({ tool: 'Bash', command: 'git worktree add -b g /r/.claude/worktrees/g main' })).result).toBe('ran')
  await new Promise<void>((resolve) => later(resolve, 0))
  expect(seen.toasts).toHaveLength(1)
  expect(seen.stats.filter((path) => path === SCRIPT)).toHaveLength(1)
  expect(seen.argvs).toEqual([])
})

// What the script was run with: the `--version` probes that resolve python are not it.
const scriptRuns = (seen: Seen): string[][] => seen.argvs.filter((argv) => argv[1] !== '--version')

test('the script that exists is run with python3 and the registration is toasted', async ($, on) => {
  const seen = stubs(on, '/home/t', { value: { kind: 'file', size: 1, mtimeMs: 0 } })
  on('process.run', ($$, e) => {
    seen.argvs.push((e as { argv: string[] }).argv)
    return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
  })
  const done = seen.nextToast()
  await $.tool.call({ ...ADD })
  expect(await done).toBe('worktree registered: /r/.claude/worktrees/f')
  expect(scriptRuns(seen)[0]?.slice(0, 2)).toEqual(['python3', SCRIPT])
  expect(scriptRuns(seen)[0]).toContain('register-worktree')
})

test('a script that fails shows its stderr', async ($, on) => {
  const seen = stubs(on, '/home/t', { value: { kind: 'file', size: 1, mtimeMs: 0 } })
  on('process.run', ($$, e) =>
    (e as { argv: string[] }).argv[1] === '--version'
      ? { value: { exitCode: 0, stdout: 'Python 3.12.1', stderr: '' } as never }
      : { value: { exitCode: 2, stdout: '', stderr: 'sandbox: write denied' } as never },
  )
  const done = seen.nextToast()
  await $.tool.call({ ...ADD })
  expect(await done).toBe('worktree NOT registered (sandbox: write denied)')
})

test('a machine where no python starts is told every reason, in the order tried', async ($, on) => {
  const seen = stubs(on, '/home/t', { value: { kind: 'file', size: 1, mtimeMs: 0 } })
  on('process.run', () => ({ deny: 'sandbox: exec of python is not permitted' }))
  const done = seen.nextToast()
  await $.tool.call({ ...ADD })
  expect(await done).toMatch(
    /^worktree NOT registered \(no python could run: python3: could not start \(.*not permitted.*\); python: could not start \(.*\); py: could not start \(.*\)\); no further worktree is registered this session$/,
  )
})

// A Windows machine: python3 is the Store alias (exit 9009 with a message), python is absent, py is the launcher.
test('python3 that exits non-zero and python that is absent leave py, which then runs the script', async ($, on) => {
  const seen = stubs(on, '/home/t', { value: { kind: 'file', size: 1, mtimeMs: 0 } })
  on('process.run', ($$, e) => {
    const argv = (e as { argv: string[] }).argv
    seen.argvs.push(argv)
    if (argv[0] === 'python3') return { value: { exitCode: 9009, stdout: '', stderr: 'Python was not found' } as never }
    if (argv[0] === 'python') return { deny: 'spawn python ENOENT' }
    return { value: { exitCode: 0, stdout: argv[1] === '--version' ? 'Python 3.12.1' : '', stderr: '' } as never }
  })
  const done = seen.nextToast()
  await $.tool.call({ ...ADD })
  expect(await done).toBe('worktree registered: /r/.claude/worktrees/f')
  expect(seen.argvs.slice(0, 3)).toEqual([['python3', '--version'], ['python', '--version'], ['py', '--version']])
  expect(scriptRuns(seen)[0]?.slice(0, 2)).toEqual(['py', SCRIPT])
})

test('python3 exiting non-zero is not python: with nothing else the failure is reported, never passed', async ($, on) => {
  const seen = stubs(on, '/home/t', { value: { kind: 'file', size: 1, mtimeMs: 0 } })
  on('process.run', () => ({ value: { exitCode: 9009, stdout: '', stderr: 'Python was not found' } as never }))
  const done = seen.nextToast()
  await $.tool.call({ ...ADD })
  expect(await done).toBe(
    'worktree NOT registered (no python could run: python3: exit 9009; python: exit 9009; py: exit 9009); no further worktree is registered this session',
  )
})

test('a script that python starts but cannot run is shown with the interpreter that tried', async ($, on) => {
  const seen = stubs(on, '/home/t', { value: { kind: 'file', size: 1, mtimeMs: 0 } })
  on('process.run', ($$, e) => {
    const argv = (e as { argv: string[] }).argv
    return argv[1] === '--version' ? ({ value: { exitCode: 0, stdout: 'Python 3.12.1', stderr: '' } as never }) : { deny: 'sandbox: exec of the script is not permitted' }
  })
  const done = seen.nextToast()
  await $.tool.call({ ...ADD })
  expect(await done).toMatch(/^worktree NOT registered \(python3 could not run the script: .*not permitted.*\); no further worktree is registered this session$/)
})

test('a python that cannot start is said once and tried once for the session, not once per worktree', async ($, on) => {
  const seen = stubs(on, '/home/t', { value: { kind: 'file', size: 1, mtimeMs: 0 } })
  on('process.run', ($$, e) => {
    seen.argvs.push((e as { argv: string[] }).argv)
    return { deny: 'sandbox: exec of python3 is not permitted' }
  })
  const first = seen.nextToast()
  await $.tool.call({ ...ADD })
  await first
  // A second worktree: every step is an already-resolved promise, so one turn of the event loop
  // lets a registration that did run reach its toast (a yield, not a wait on the clock).
  expect((await $.tool.call({ tool: 'Bash', command: 'git worktree add -b g /r/.claude/worktrees/g main' })).result).toBe('ran')
  await new Promise<void>((resolve) => later(resolve, 0))
  expect(seen.toasts).toHaveLength(1)
  expect(seen.argvs.map((argv) => argv[0])).toEqual(['python3', 'python', 'py'])
})

test('python is resolved once per session: a second worktree runs the script without probing again', async ($, on) => {
  const seen = stubs(on, '/home/t', { value: { kind: 'file', size: 1, mtimeMs: 0 } })
  on('process.run', ($$, e) => {
    seen.argvs.push((e as { argv: string[] }).argv)
    return { value: { exitCode: 0, stdout: 'Python 3.12.1', stderr: '' } as never }
  })
  const first = seen.nextToast()
  await $.tool.call({ ...ADD })
  await first
  const second = seen.nextToast()
  await $.tool.call({ tool: 'Bash', command: 'git worktree add -b g /r/.claude/worktrees/g main' })
  await second
  expect(seen.argvs.filter((argv) => argv[1] === '--version')).toHaveLength(1)
  expect(scriptRuns(seen)).toHaveLength(2)
})

test('without HOME or USERPROFILE the toast says why the script has no place', async ($, on) => {
  const seen = stubs(on, undefined, { value: { kind: 'file', size: 1, mtimeMs: 0 } })
  const done = seen.nextToast()
  await $.tool.call({ ...ADD })
  expect(await done).toMatch(/hygiene script not found at ~\/Developments\/disk-hygiene\/disk_hygiene\.py; worktrees are not registered \(~\/Developments\/disk-hygiene\/disk_hygiene\.py has no place: neither HOME nor USERPROFILE is set/)
})

test('an environment the sandbox refuses to read is the reason the script has no place', async ($, on) => {
  const seen = stubs(on, { deny: 'env access is not allowed' }, { value: { kind: 'file', size: 1, mtimeMs: 0 } })
  const done = seen.nextToast()
  await $.tool.call({ ...ADD })
  expect(await done).toMatch(/worktrees are not registered \(the environment is unreadable: .*env access is not allowed/)
})

test('an explicitly empty option disables registration with no toast and no lookup', { options: { hygiene_script: '' } }, async ($, on) => {
  const seen = stubs(on, '/home/t', { deny: 'would be missing' })
  expect((await $.tool.call({ ...ADD })).result).toBe('ran')
  expect(seen.toasts).toEqual([])
  expect(seen.stats.filter((path) => path === SCRIPT)).toEqual([])
})

test('an absolute path in the option is used as given', { options: { hygiene_script: '/opt/h.py' } }, async ($, on) => {
  const seen = stubs(on, '/home/t', { value: { kind: 'file', size: 1, mtimeMs: 0 } })
  on('process.run', ($$, e) => {
    seen.argvs.push((e as { argv: string[] }).argv)
    return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
  })
  const done = seen.nextToast()
  await $.tool.call({ ...ADD })
  await done
  expect(scriptRuns(seen)[0]?.[1]).toBe('/opt/h.py')
})

// Audience: `$.ui.toast` is read by the user alone and a tool.call result's `context` by the model alone (the
// engine's declarations). A worktree that did not get registered is news for both: the user is toasted, and
// Claude, which ran `git worktree add`, is told on the result of that call that its cleanup is not covered.
const NEW = '/r/.claude/worktrees/f'

test('a worktree that is not registered is toasted to the user and told to Claude in the result context', async ($, on) => {
  const seen = stubs(on, '/home/t', { value: { kind: 'file', size: 1, mtimeMs: 0 } })
  on('process.run', ($$, e) =>
    (e as { argv: string[] }).argv[1] === '--version'
      ? { value: { exitCode: 0, stdout: 'Python 3.12.1', stderr: '' } as never }
      : { value: { exitCode: 2, stdout: '', stderr: 'sandbox: write denied' } as never },
  )
  const ran = await $.tool.call({ ...ADD })
  expect(ran.result).toBe('ran')
  expect(seen.toasts).toEqual(['worktree NOT registered (sandbox: write denied)'])
  expect(ran.context).toHaveLength(1)
  expect(ran.context?.[0]).toContain(NEW)
  expect(ran.context?.[0]).toContain('NOT registered')
  expect(ran.context?.[0]).toContain('cleanup is not covered')
  expect(ran.context?.[0]).toContain('sandbox: write denied')
  expect(ran.context?.[0]).not.toBe(seen.toasts[0])
})

test('a missing script tells Claude as well; a later worktree tells Claude again and the user not again', async ($, on) => {
  const seen = stubs(on, '/home/t', { deny: 'ENOENT: no such file' })
  const first = await $.tool.call({ ...ADD })
  expect(first.context?.[0]).toContain('cleanup is not covered')
  expect(seen.toasts).toHaveLength(1)
  const second = await $.tool.call({ tool: 'Bash', command: 'git worktree add -b g /r/.claude/worktrees/g main' })
  expect(second.context?.[0]).toContain('/r/.claude/worktrees/g')
  expect(seen.toasts).toHaveLength(1)
})

test('a worktree that is registered tells Claude nothing', async ($, on) => {
  const seen = stubs(on, '/home/t', { value: { kind: 'file', size: 1, mtimeMs: 0 } })
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'Python 3.12.1', stderr: '' } as never }))
  const ran = await $.tool.call({ ...ADD })
  expect(seen.toasts).toEqual(['worktree registered: /r/.claude/worktrees/f'])
  expect(ran.context).toBeUndefined()
})

test('registration switched off by the option tells Claude nothing: no cleanup was promised', { options: { hygiene_script: '' } }, async ($, on) => {
  stubs(on, '/home/t', { deny: 'would be missing' })
  expect((await $.tool.call({ ...ADD })).context).toBeUndefined()
})

// Another plugin refused the add before it ran: no worktree exists, so nothing is run, toasted or told to Claude.
test('an add another plugin refused is not registered', async ($, on) => {
  const seen = stubs(on, '/home/t', { value: { kind: 'file', size: 1, mtimeMs: 0 } }, { call: { deny: 'another plugin: no' }, makes: [] })
  let runs = 0
  on('process.run', () => {
    runs += 1
    return { value: { exitCode: 0, stdout: 'Python 3.12.1', stderr: '' } as never }
  })
  const ran = await $.tool.call({ ...ADD })
  expect(ran.deny).toBe('another plugin: no')
  expect(ran.context).toBeUndefined()
  expect(runs).toBe(0)
  expect(seen.toasts).toEqual([])
})

// The add itself failed (git exited non-zero): no worktree exists, so nothing is registered or toasted.
test('an add that failed is neither registered nor told to Claude', async ($, on) => {
  const seen = stubs(on, '/home/t', { deny: 'ENOENT: no such file' }, { call: { result: 'fatal: invalid reference: main', isError: true }, makes: [] })
  const ran = await $.tool.call({ ...ADD })
  expect(ran.isError).toBe(true)
  expect(ran.context).toBeUndefined()
  expect(seen.toasts).toEqual([])
})

// A run that hangs is killed by the engine at its timeout and rejects; the mod bounds both runs itself.
test('both runs carry an explicit timeout, and a rejection on timeout is reported without blocking the add', async ($, on) => {
  const seen = stubs(on, '/home/t', { value: { kind: 'file', size: 1, mtimeMs: 0 } })
  const inits: ({ timeoutMs?: number } | undefined)[] = []
  on('process.run', ($$, e) => {
    const call = e as { argv: string[]; init?: { timeoutMs?: number } }
    inits.push(call.init)
    return call.argv[1] === '--version'
      ? { value: { exitCode: 0, stdout: 'Python 3.12.1', stderr: '' } as never }
      : { deny: 'timed out after 10000ms' }
  })
  const ran = await $.tool.call({ ...ADD })
  expect(ran.result).toBe('ran')
  expect(inits.map((init) => init?.timeoutMs)).toEqual([5_000, 10_000])
  expect(seen.toasts[0]).toMatch(/^worktree NOT registered \(python3 could not run the script: .*timed out after 10000ms.*\)/)
  expect(ran.context?.[0]).toContain('timed out after 10000ms')
})

// What decides a registration is the worktree on disk after the call, not the call's outcome: a later step of
// the command can fail, and another plugin can turn a call that ran into a deny (the engine's declarations: a
// deny returned after `next(e)` "undoes nothing: a tool that ran has run").
const okRuns = (on: Parameters<TestBody>[1], seen: Seen): void => {
  on('process.run', ($$, e) => {
    seen.argvs.push((e as { argv: string[] }).argv)
    return { value: { exitCode: 0, stdout: 'Python 3.12.1', stderr: '' } as never }
  })
}
const CHAINED = { tool: 'Bash', command: 'git worktree add -b f /r/.claude/worktrees/f main && npm ci' } as const
const NPM_FAILED = { result: 'npm ERR! code ERESOLVE', isError: true }
const pathOfRun = (seen: Seen): string | undefined => {
  const argv = scriptRuns(seen)[0] ?? []
  return argv[argv.indexOf('--path') + 1]
}

test('an add whose later step failed leaves a worktree, and it is registered', async ($, on) => {
  const seen = stubs(on, '/home/t', { value: { kind: 'file', size: 1, mtimeMs: 0 } }, { call: NPM_FAILED })
  okRuns(on, seen)
  const ran = await $.tool.call({ ...CHAINED })
  expect(ran.isError).toBe(true)
  expect(seen.toasts).toEqual(['worktree registered: /r/.claude/worktrees/f'])
  expect(pathOfRun(seen)).toBe('/r/.claude/worktrees/f')
  expect(ran.context).toBeUndefined()
})

test('an add whose later step failed and whose registration failed is told to the user and to Claude', async ($, on) => {
  const seen = stubs(on, '/home/t', { deny: 'ENOENT: no such file' }, { call: NPM_FAILED })
  const ran = await $.tool.call({ ...CHAINED })
  expect(ran.isError).toBe(true)
  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toMatch(/^hygiene script not found/)
  expect(ran.context?.[0]).toContain(NEW)
  expect(ran.context?.[0]).toContain('NOT registered')
})

test('an add that ran and that another plugin then denied leaves a worktree, and it is registered', async ($, on) => {
  const seen = stubs(on, '/home/t', { value: { kind: 'file', size: 1, mtimeMs: 0 } }, { call: { deny: 'another plugin: rewritten after the run' } })
  okRuns(on, seen)
  const ran = await $.tool.call({ ...ADD })
  expect(ran.deny).toBe('another plugin: rewritten after the run')
  expect(seen.toasts).toEqual(['worktree registered: /r/.claude/worktrees/f'])
  expect(pathOfRun(seen)).toBe('/r/.claude/worktrees/f')
})

test("a worktree that was there before the call is not this call's, and it is not registered", async ($, on) => {
  const seen = stubs(on, '/home/t', { value: { kind: 'file', size: 1, mtimeMs: 0 } }, {
    call: { result: "fatal: '/r/.claude/worktrees/f' already exists", isError: true },
    before: [NEW],
    makes: [],
  })
  okRuns(on, seen)
  const ran = await $.tool.call({ ...ADD })
  expect(scriptRuns(seen)).toEqual([])
  expect(seen.toasts).toEqual([])
  expect(ran.context).toBeUndefined()
})

test("a worktree removed and added again at the same place by the call is this call's, and it is registered", async ($, on) => {
  const seen = stubs(on, '/home/t', { value: { kind: 'file', size: 1, mtimeMs: 0 } }, { before: [NEW], makes: [], remakes: [NEW] })
  okRuns(on, seen)
  await $.tool.call({ ...ADD })
  expect(scriptRuns(seen)).toHaveLength(1)
  expect(seen.toasts).toEqual(['worktree registered: /r/.claude/worktrees/f'])
})

// A relative path is the shell's, and the shell starts where the session is (`$.session.cwd()`, read before
// the call); a leading `cd <dir> &&` moves it before git runs.
test('a relative add after a leading cd is registered where the cd took the shell', async ($, on) => {
  const seen = stubs(on, '/home/t', { value: { kind: 'file', size: 1, mtimeMs: 0 } }, { cwd: '/elsewhere', makes: [NEW] })
  okRuns(on, seen)
  await $.tool.call({ tool: 'Bash', command: 'cd /r && git worktree add -b f ./.claude/worktrees/f main' })
  expect(seen.toasts).toEqual(['worktree registered: /r/.claude/worktrees/f'])
  expect(pathOfRun(seen)).toBe('/r/.claude/worktrees/f')
})

test('a relative add with no directory change is registered under the session directory', async ($, on) => {
  const seen = stubs(on, '/home/t', { value: { kind: 'file', size: 1, mtimeMs: 0 } }, { cwd: '/r', makes: [NEW] })
  okRuns(on, seen)
  await $.tool.call({ tool: 'Bash', command: 'git worktree add -b f ./.claude/worktrees/f main' })
  expect(seen.toasts).toEqual(['worktree registered: /r/.claude/worktrees/f'])
  expect(pathOfRun(seen)).toBe('/r/.claude/worktrees/f')
})

test('a relative add whose directory cannot be known registers nothing and says so to the user and to Claude', async ($, on) => {
  const seen = stubs(on, '/home/t', { value: { kind: 'file', size: 1, mtimeMs: 0 } }, { cwd: '/elsewhere', makes: [NEW] })
  okRuns(on, seen)
  const ran = await $.tool.call({ tool: 'Bash', command: 'pushd /r && git worktree add -b f ./.claude/worktrees/f main' })
  expect(scriptRuns(seen)).toEqual([])
  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toMatch(/^worktree NOT registered \(the path \.\/\.claude\/worktrees\/f could not be resolved: .*pushd/)
  expect(ran.context?.[0]).toContain('.claude/worktrees/f')
  expect(ran.context?.[0]).toContain('could not be resolved')
})

// A command sent to the background has not finished when the call returns: the worktree may not be there yet.
test('an add sent to the background is not looked for too early: the user and Claude are told it was not checked', async ($, on) => {
  const seen = stubs(on, '/home/t', { value: { kind: 'file', size: 1, mtimeMs: 0 } }, {
    call: { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } },
    makes: [],
  })
  okRuns(on, seen)
  const ran = await $.tool.call({ ...ADD })
  expect(scriptRuns(seen)).toEqual([])
  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toMatch(/^worktree NOT registered \(.*background/)
  expect(ran.context?.[0]).toContain(NEW)
  expect(ran.context?.[0]).toContain('background')
})

// Round 1 of PR 30. A place computed wrong must never fall silent: the three shapes measured on real git (each
// created a worktree and said nothing), a shell that was not where the session says, a `.git` file that is not a
// linked worktree's, the option off, and text that only mentions the phrase.
const FULL = { value: { kind: 'file', size: 1, mtimeMs: 0 } }
const told = (ran: { context?: readonly string[] }, path: string): void => {
  expect(ran.context).toHaveLength(1)
  expect(ran.context?.[0]).toContain(path)
  expect(ran.context?.[0]).toContain('NOT registered')
}

for (const [name, command, made] of [
  ['a cd glued to a `;`', 'true;cd sub && git worktree add ../.claude/worktrees/w7 -b b7', '/r/.claude/worktrees/w7'],
  ['a cd glued to a `&&`', 'echo x &&cd sub && git worktree add ../.claude/worktrees/w11 -b b11', '/r/.claude/worktrees/w11'],
  ['a quoted path with a space', 'git worktree add "./.claude/worktrees/w 5" -b b5', '/r/.claude/worktrees/w 5'],
] as const) {
  test(`${name} made a worktree: the user and Claude are told it was not registered`, async ($, on) => {
    const seen = stubs(on, '/home/t', FULL, { cwd: '/r', makes: [made] })
    okRuns(on, seen)
    const ran = await $.tool.call({ tool: 'Bash', command })
    expect(scriptRuns(seen)).toEqual([])
    expect(seen.toasts).toHaveLength(1)
    expect(seen.toasts[0]).toMatch(/^worktree NOT registered \(the path .* could not be resolved: /)
    told(ran, command.includes('"') ? './.claude/worktrees/w' : '.claude/worktrees/w')
  })
}

test('a shell that was not where the session says leaves nothing at the place computed: the user and Claude are told', async ($, on) => {
  const seen = stubs(on, '/home/t', FULL, { cwd: '/r', makes: ['/elsewhere/.claude/worktrees/f'] })
  okRuns(on, seen)
  const ran = await $.tool.call({ tool: 'Bash', command: 'git worktree add -b f ./.claude/worktrees/f main' })
  expect(scriptRuns(seen)).toEqual([])
  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toMatch(/^worktree NOT registered \(no worktree was found at \/r\/\.claude\/worktrees\/f after the call, which reported no error, so the worktree may be elsewhere\)$/)
  told(ran, NEW)
  expect(ran.context?.[0]).toContain('may be elsewhere')
})

// A `.git` file that names `.git/modules/<name>` is a submodule's, not a linked worktree's (git-worktree(1) DETAILS).
test("a .git file that is not a linked worktree's is not registered, and the missing worktree is reported", async ($, on) => {
  const seen = stubs(on, '/home/t', FULL, { makes: [NEW], gitfile: 'gitdir: /r/.git/modules/x\n' })
  okRuns(on, seen)
  const ran = await $.tool.call({ ...ADD })
  expect(scriptRuns(seen)).toEqual([])
  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toMatch(/^worktree NOT registered \(no worktree was found at /)
  told(ran, NEW)
})

test('with the option off an add whose place cannot be known or found tells nobody: no cleanup was promised', { options: { hygiene_script: '' } }, async ($, on) => {
  const seen = stubs(on, '/home/t', FULL, { cwd: '/r', makes: [] })
  okRuns(on, seen)
  const unknown = await $.tool.call({ tool: 'Bash', command: 'pushd /r && git worktree add -b f ./.claude/worktrees/f main' })
  const missing = await $.tool.call({ tool: 'Bash', command: 'git worktree add -b g ./.claude/worktrees/g main' })
  expect(seen.toasts).toEqual([])
  expect(unknown.context).toBeUndefined()
  expect(missing.context).toBeUndefined()
})

// A deny carries no `context`: the user's toast is the only channel then.
test('an unresolvable add that another plugin denied is toasted to the user and adds nothing to a deny', async ($, on) => {
  const seen = stubs(on, '/home/t', FULL, { cwd: '/r', call: { deny: 'another plugin: no' }, makes: [] })
  okRuns(on, seen)
  const ran = await $.tool.call({ tool: 'Bash', command: 'pushd /r && git worktree add -b f ./.claude/worktrees/f main' })
  expect(ran.deny).toBe('another plugin: no')
  expect(ran.context).toBeUndefined()
  expect(seen.toasts).toHaveLength(1)
})

test('a leading cd followed by commands that move nothing is registered where the cd took the shell', async ($, on) => {
  const seen = stubs(on, '/home/t', FULL, { cwd: '/elsewhere', makes: [NEW] })
  okRuns(on, seen)
  const ran = await $.tool.call({ tool: 'Bash', command: 'cd /r && git fetch && git worktree add -b f ./.claude/worktrees/f origin/main' })
  expect(seen.toasts).toEqual(['worktree registered: /r/.claude/worktrees/f'])
  expect(pathOfRun(seen)).toBe(NEW)
  expect(ran.context).toBeUndefined()
})

test('text that only mentions the phrase after a cd is neither registered nor reported', async ($, on) => {
  const seen = stubs(on, '/home/t', FULL, { cwd: '/r', makes: [] })
  okRuns(on, seen)
  const commit = await $.tool.call({ tool: 'Bash', command: 'cd /r && git commit -m "docs: git worktree add ./.claude/worktrees/x is now registered"' })
  const body = await $.tool.call({ tool: 'Bash', command: "cd /r && gh pr create --body \"$(cat <<'EOF'\nrun git worktree add ../r/.claude/worktrees/x main\nEOF\n)\"" })
  expect(seen.toasts).toEqual([])
  expect(scriptRuns(seen)).toEqual([])
  expect(commit.context).toBeUndefined()
  expect(body.context).toBeUndefined()
})

// The event of a subagent's loop carries `agentId`; the d.ts does not say which directory `$.session.cwd()` is for it.
// The engine's input type for a call does not declare it (the loop sets it), hence the cast.
const inSubagent = (input: object): never => ({ ...input, agentId: 'a1' }) as never
test('a relative add inside a subagent is reported as unresolved; an absolute one is registered', async ($, on) => {
  const seen = stubs(on, '/home/t', FULL, { cwd: '/r', makes: [NEW] })
  okRuns(on, seen)
  const ran = await $.tool.call(inSubagent({ tool: 'Bash', command: 'git worktree add -b f ./.claude/worktrees/f main' }))
  expect(scriptRuns(seen)).toEqual([])
  expect(seen.toasts[0]).toMatch(/^worktree NOT registered \(the path \.\/\.claude\/worktrees\/f could not be resolved: a subagent/)
  told(ran, './.claude/worktrees/f')
})

test('an absolute add inside a subagent does not depend on its directory and is registered', async ($, on) => {
  const seen = stubs(on, '/home/t', FULL, { cwd: '/r' })
  okRuns(on, seen)
  await $.tool.call(inSubagent(ADD))
  expect(pathOfRun(seen)).toBe(NEW)
})
