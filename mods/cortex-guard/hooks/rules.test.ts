import { expect, test } from 'claude-code/testing'

import { PYTHON_CANDIDATES, WORKTREE_ROOTS, isInsideWorktreeRoot, withSlashes } from './rules'

test('a worktree root is recognised in a POSIX or a Windows spelling', () => {
  expect(isInsideWorktreeRoot('/r/.claude/worktrees/f')).toBe(true)
  expect(isInsideWorktreeRoot('/r/.Codex/worktrees/f')).toBe(true)
  expect(isInsideWorktreeRoot('C:\\Users\\t\\repo\\.claude\\worktrees\\f')).toBe(true)
  expect(isInsideWorktreeRoot('C:\\Users\\t\\repo\\.Codex\\worktrees\\f')).toBe(true)
  expect(isInsideWorktreeRoot('C:/Users/t/repo/.claude/worktrees/f')).toBe(true)
  expect(isInsideWorktreeRoot('C:\\Users\\t\\wt\\f')).toBe(false)
  expect(isInsideWorktreeRoot('C:\\Users\\t\\.claude\\other\\f')).toBe(false)
  expect(isInsideWorktreeRoot('/tmp/wt')).toBe(false)
})

test('separators are normalised and nothing else is touched', () => {
  expect(withSlashes('a\\b\\c.md')).toBe('a/b/c.md')
  expect(withSlashes('a/b')).toBe('a/b')
  expect(WORKTREE_ROOTS.every((root) => !root.includes('\\'))).toBe(true)
})

test('python is tried as python3, then python, then py', () => {
  expect([...PYTHON_CANDIDATES]).toEqual(['python3', 'python', 'py'])
})
