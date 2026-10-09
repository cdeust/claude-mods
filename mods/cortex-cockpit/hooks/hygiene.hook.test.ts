import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// The hygiene read through the engine: the worktree list, the registry file and the process table
// are three reads, and each one that fails says so on its own instead of reading as "nothing".

type Ran = { exitCode: number; stdout: string; stderr: string } | { deny: string }
type World = {
  ps?: Ran
  registry?: 'absent' | string | { deny: string }
  env?: Record<string, string>
  reads?: string[]
}

const PORCELAIN = 'worktree /r\nHEAD aaaa\nbranch refs/heads/main\n\nworktree /r/.claude/worktrees/x\nHEAD bbbb\nbranch refs/heads/x\n'
const PS = '  PID ELAPSED COMMAND\n  123 01:02 python3 -m pytest tests\n'

type Written = { worktrees: { path: string; isRegistered: boolean }[]; testProcesses: { pid: number }[]; processesError: string | null; ownershipError: string | null; error: string | null }

// Runs session.start (which reads the hygiene in the background) and returns the snapshot the mod
// wrote, once the write that ends the read has happened.
async function snapshotOf($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], w: World): Promise<Written> {
  mock.clock(on, { now: 1_000_000 })
  const vars = w.env ?? { HOME: '/home/t' }
  on('session.start', () => ({ cwd: '/r' }))
  on('session.repo', () => ({ value: undefined }) as never)
  on('env.get', (_$, e) => ({ value: vars[String((e as { name?: string }).name ?? '')] as never }))
  on('command.register', () => ({ value: undefined }) as never)
  on('mcp.call', () => ({ deny: 'no MCP server in this test' }))
  on('fs.exists', () => ({ value: w.registry !== 'absent' }))
  on('fs.read', (_$, e) => {
    w.reads?.push(String((e as { path?: string }).path ?? ''))
    const file = w.registry ?? '{}'

    return typeof file === 'string' ? { value: file } : file
  })
  on('process.run', (_$, e) => {
    const argv = (e as { argv: string[] }).argv
    const out: Ran = argv[0] === 'ps' ? (w.ps ?? { exitCode: 0, stdout: PS, stderr: '' }) : { exitCode: 0, stdout: PORCELAIN, stderr: '' }

    return 'deny' in out ? out : { value: out as never }
  })
  let written: Written | undefined
  let settled: () => void = () => undefined
  const done = new Promise<void>((resolve) => (settled = resolve))
  on('state.set', (_$, e, next) => {
    if ((e as { key?: string }).key === 'hygiene') {
      written = (e as unknown as { value: Written }).value
      settled()
    }
    return next(e)
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await done

  return written as Written
}

test('a machine that answers: worktrees, the registry and the test runners are read', async ($, on) => {
  const snap = await snapshotOf($, on, { registry: JSON.stringify({ '/r/.claude/worktrees/x': { owner: 'claude:s1' } }) })
  expect(snap.error).toBe(null)
  expect(snap.processesError).toBe(null)
  expect(snap.ownershipError).toBe(null)
  expect(snap.testProcesses.map((p) => p.pid)).toEqual([123])
  expect(snap.worktrees[1]?.isRegistered).toBe(true)
})

test('a ps that exits non-zero is "no reading" with its stderr, not "no test runner running"', async ($, on) => {
  const snap = await snapshotOf($, on, { ps: { exitCode: 1, stdout: '', stderr: 'ps: operation not permitted' } })
  expect(snap.processesError).toBe('ps exit 1: ps: operation not permitted')
  expect(snap.testProcesses).toEqual([])
  expect(snap.worktrees.length).toBe(2)
  expect(snap.error).toBe(null)
})

test('a ps the machine will not start (Windows has none) says so, and the worktrees are still listed', async ($, on) => {
  const snap = await snapshotOf($, on, { ps: { deny: "spawn ps ENOENT" } })
  expect(snap.processesError).toMatch(/^ps could not run: .*spawn ps ENOENT/)
  expect(snap.worktrees.length).toBe(2)
})

test('a registry that is there but refused is an error carrying the refusal', async ($, on) => {
  const refused = await snapshotOf($, on, { registry: { deny: 'EACCES: permission denied' } })
  expect(refused.ownershipError).toMatch(/EACCES: permission denied/)
})

test('a registry that is not JSON names the file', async ($, on) => {
  const snap = await snapshotOf($, on, { registry: '{truncated' })
  expect(snap.ownershipError).toMatch(/ownership\.json is not valid JSON/)
})

test('no registry file at all is an empty registry: nothing was ever registered', async ($, on) => {
  const snap = await snapshotOf($, on, { registry: 'absent' })
  expect(snap.ownershipError).toBe(null)
  expect(snap.worktrees[1]?.isRegistered).toBe(false)
})

test('the registry is placed under USERPROFILE when HOME is unset', async ($, on) => {
  const reads: string[] = []
  await snapshotOf($, on, { env: { USERPROFILE: 'C:\\Users\\t' }, reads })
  expect(reads.some((r) => r.endsWith('C:\\Users\\t/.local/state/disk-hygiene/ownership.json'))).toBe(true)
})

test('with no home the registry has no place, and says so', async ($, on) => {
  const snap = await snapshotOf($, on, { env: {} })
  expect(snap.ownershipError).toMatch(/no place: neither HOME nor USERPROFILE is set/)
})
