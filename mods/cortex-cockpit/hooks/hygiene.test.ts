import { expect, test } from 'claude-code/testing'

import { parseOwnership, parsePorcelain, psRefusal, shortPath, testProcesses, worktrees } from './hygiene'

const PORCELAIN = `worktree /r
HEAD aaaa
branch refs/heads/main

worktree /r/.claude/worktrees/feat-x
HEAD bbbb
branch refs/heads/feat/x

worktree /tmp/stray
HEAD cccc
detached
`

test('porcelain stanzas become worktrees, main first', () => {
  const list = parsePorcelain(PORCELAIN)
  expect(list.length).toBe(3)
  expect(list[0]).toEqual({ path: '/r', branch: 'refs/heads/main' })
  expect(list[2]).toEqual({ path: '/tmp/stray', branch: null })
})

test('worktrees are checked against the rule and the registry', () => {
  const own = parseOwnership(
    JSON.stringify({
      '/r/.claude/worktrees/feat-x': { owner: 'claude:s1', pr: 'https://x/pr/1', kind: 'worktree' },
    }),
  )
  const w = worktrees(PORCELAIN, own)
  expect(w[0]?.isMain).toBe(true)
  expect(w[0]?.isInsideRepoRule).toBe(true)
  expect(w[1]).toEqual({
    path: '/r/.claude/worktrees/feat-x',
    branch: 'refs/heads/feat/x',
    isMain: false,
    isInsideRepoRule: true,
    isRegistered: true,
    owner: 'claude:s1',
    pr: 'https://x/pr/1',
  })
  expect(w[2]?.isInsideRepoRule).toBe(false)
  expect(w[2]?.isRegistered).toBe(false)
  expect(w[1]?.isRegistered).toBe(true)
})

test('test runners are picked out of ps, grep lines and the header are not', () => {
  const ps = `  PID     ELAPSED COMMAND
  123    01:02:03 /usr/bin/python3 -m pytest tests_py/core
  124       00:05 grep pytest
  125    00:00:09 node vitest run`
  const procs = testProcesses(ps)
  expect(procs.length).toBe(2)
  expect(procs[0]?.pid).toBe(123)
  expect(procs[0]?.elapsed).toBe('01:02:03')
  expect(procs[1]?.command).toContain('vitest')
})

test('paths are shortened under the repo', () => {
  expect(shortPath('/r/.claude/worktrees/a', '/r')).toBe('.claude/worktrees/a')
  expect(shortPath('/r', '/r')).toBe('.')
  expect(shortPath('/tmp/x', '/r')).toBe('/tmp/x')
})

test('a registry that is not the JSON object disk_hygiene writes is an error, not an empty registry', () => {
  expect(() => parseOwnership('nope')).toThrow(/ownership\.json is not valid JSON/)
  expect(() => parseOwnership('[]')).toThrow(/ownership\.json is not an object/)
  expect(() => parseOwnership('null')).toThrow(/ownership\.json is not an object/)
  expect(parseOwnership('{}')).toEqual({})
})

test('a ps that exits non-zero has no process table to read', () => {
  expect(psRefusal({ exitCode: 0, stderr: '' })).toBe(null)
  expect(psRefusal({ exitCode: 1, stderr: 'ps: illegal option -- e\nusage' })).toBe('ps exit 1: ps: illegal option -- e\nusage')
  expect(psRefusal({ exitCode: 127, stderr: '' })).toBe('ps exit 127: no output')
})
