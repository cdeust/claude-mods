import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// The registration of a worktree through the hygiene script, on a machine that is not the
// owner's: the script's place is computed from HOME, a missing file is said once, a refusal from
// the machine is shown. Registration runs after the call; each test waits on
// the toast it produces, the event that ends it. The call itself waits for the registration, so that
// a failure can be told to Claude in the call's result (the audience tests at the end).

const SCRIPT = '/home/t/Developments/disk-hygiene/disk_hygiene.py'
// These fixtures start at /: Windows adds the current drive and uses backslashes.
// Compare the full rooted path after removing only those platform differences.
const rootedPath = (path: string): string => path.replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/)/, '')
const registeredPath = (toast: string): string => {
  const prefix = 'worktree registered: '
  expect(toast.startsWith(prefix)).toBe(true)
  return rootedPath(toast.slice(prefix.length))
}
const ADD = { tool: 'Bash', command: 'git worktree add -b f /r/.claude/worktrees/f main' } as const

// `lib` names no DOM, so the timer is reached through the global object.
const later = (globalThis as unknown as { setTimeout: (run: () => void, ms: number) => unknown }).setTimeout

type Seen = { toasts: string[]; argvs: string[][]; stats: string[]; nextToast: () => Promise<string> }

// `home` answers HOME alone; the other variables the mod asks for are unset.
const stubs = (on: Parameters<TestBody>[1], home: string | undefined | { deny: string }, scriptStat: unknown, how: { call?: unknown } = {}): Seen => {
  const seen: Seen = { toasts: [], argvs: [], stats: [], nextToast: () => Promise.resolve('') }
  let waiting: ((text: string) => void) | undefined
  seen.nextToast = () => new Promise((resolve) => (waiting = resolve))
  mock.clock(on, { now: 1_000_000 })
  on('env.get', ($, e) =>
    typeof home === 'object' ? home : { value: ((e as { name?: string }).name === 'HOME' ? home : undefined) as never },
  )
  on('session.id', () => ({ value: 'test-session' }))
  on('fs.stat', ($, e) => {
    seen.stats.push(e.path)
    return rootedPath(e.path) === SCRIPT ? (scriptStat as never) : ({ value: { kind: 'file', size: 1, mtimeMs: 0, realPath: e.path } as never })
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    waiting?.(e.text)
    return { value: undefined }
  })
  on('tool.call', () => (how.call ?? { result: 'ran' }) as never)
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
  expect(seen.stats.filter((path) => rootedPath(path) === SCRIPT)).toHaveLength(1)
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
  expect(registeredPath(await done)).toBe('/r/.claude/worktrees/f')
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
  expect(registeredPath(await done)).toBe('/r/.claude/worktrees/f')
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
  expect(seen.stats.filter((path) => rootedPath(path) === SCRIPT)).toEqual([])
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
  expect(seen.toasts.map(registeredPath)).toEqual(['/r/.claude/worktrees/f'])
  expect(ran.context).toBeUndefined()
})

test('registration switched off by the option tells Claude nothing: no cleanup was promised', { options: { hygiene_script: '' } }, async ($, on) => {
  stubs(on, '/home/t', { deny: 'would be missing' })
  expect((await $.tool.call({ ...ADD })).context).toBeUndefined()
})

// Another plugin refused the add: no worktree exists, so there is nothing to tell Claude about, whatever the
// registration says (here the script is missing, which would otherwise be context).
test('an add another plugin refused carries no registration context', async ($, on) => {
  stubs(on, '/home/t', { deny: 'ENOENT: no such file' }, { call: { deny: 'another plugin: no' } })
  const ran = await $.tool.call({ ...ADD })
  expect(ran.deny).toBe('another plugin: no')
  expect(ran.context).toBeUndefined()
})

// The same refusal with a script that would register: nothing is run and the user is not told "registered".
test('an add another plugin refused is not registered', async ($, on) => {
  const seen = stubs(on, '/home/t', { value: { kind: 'file', size: 1, mtimeMs: 0 } }, { call: { deny: 'another plugin: no' } })
  let runs = 0
  on('process.run', () => {
    runs += 1
    return { value: { exitCode: 0, stdout: 'Python 3.12.1', stderr: '' } as never }
  })
  const ran = await $.tool.call({ ...ADD })
  expect(ran.deny).toBe('another plugin: no')
  expect(runs).toBe(0)
  expect(seen.toasts).toEqual([])
})

// The add itself failed (git exited non-zero): no worktree exists, so nothing is registered or toasted.
test('an add that failed is neither registered nor told to Claude', async ($, on) => {
  const seen = stubs(on, '/home/t', { deny: 'ENOENT: no such file' }, { call: { result: 'fatal: already exists', isError: true } })
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
