import { expect, test } from 'claude-code/testing'

import { judgeCall, judgePath, worktreeAddPath } from './guard'

test('refuses the generated ADR mirror and canonical wiki pages', () => {
  expect(judgePath('/r/docs/adr/ADR-1060-refuse-a-decision.md').allow).toBe(false)
  expect(judgePath('wiki/adr/cortex/1060-refuse.md').allow).toBe(false)
  expect(judgePath('/r/mcp_server/hooks/decision_gate.py').allow).toBe(true)
  expect(judgePath('wiki/README.md').allow).toBe(true)
})

test('Edit, Write and NotebookEdit are judged on their path', () => {
  expect(judgeCall('Edit', { file_path: 'docs/adr/ADR-1062-x.md' }).allow).toBe(false)
  expect(judgeCall('Write', { file_path: 'README.md' }).allow).toBe(true)
  expect(judgeCall('NotebookEdit', { notebook_path: 'wiki/specs/a.md' }).allow).toBe(false)
})

test('Bash is refused only when it writes to a protected path', () => {
  expect(judgeCall('Bash', { command: "sed -i 's/a/b/' wiki/adr/cortex/1060-x.md" }).allow).toBe(
    false,
  )
  expect(judgeCall('Bash', { command: 'echo hi > docs/adr/ADR-1060-x.md' }).allow).toBe(false)
  expect(judgeCall('Bash', { command: 'cat docs/adr/ADR-1060-x.md' }).allow).toBe(true)
  expect(judgeCall('Bash', { command: 'ls wiki/adr' }).allow).toBe(true)
})

test('git worktree add is refused outside <repo>/.claude/worktrees/', () => {
  expect(worktreeAddPath('git worktree add -b feat/x /tmp/wt main')).toBe('/tmp/wt')
  expect(worktreeAddPath('git worktree add --detach ../sibling')).toBe('../sibling')
  expect(worktreeAddPath('git worktree list')).toBe(undefined)
  // Global git options before the subcommand must not hide the rule (found live 2026-10-07).
  expect(worktreeAddPath('git -C /r worktree add /tmp/x -b guard-test')).toBe('/tmp/x')
  expect(worktreeAddPath('git --no-pager -c core.bare=false worktree add ../y')).toBe('../y')
  expect(worktreeAddPath('cd /r && git -C . worktree add /r/.claude/worktrees/z')).toBe(
    '/r/.claude/worktrees/z',
  )
  expect(judgeCall('Bash', { command: 'git -C /r worktree add /tmp/x -b t' }).allow).toBe(false)
  const bad = judgeCall('Bash', { command: 'git worktree add -b feat/x /tmp/wt main' })
  expect(bad.allow).toBe(false)
  expect(!bad.allow && bad.rule).toBe('worktree-inside-repo')
  const ok = judgeCall('Bash', {
    command: 'git worktree add -b feat/x /r/.claude/worktrees/feat-x main',
  })
  expect(ok.allow).toBe(true)
  const codex = judgeCall('Bash', { command: 'git worktree add /r/.Codex/worktrees/a' })
  expect(codex.allow).toBe(true)
})

// The audit (M5): the patterns are written with `/`, so a backslash path slipped past the wiki
// rule and a worktree inside the repo was judged outside it.
test('a Windows spelling of a protected path is refused like the POSIX one', () => {
  expect(judgePath('C:\\r\\docs\\adr\\ADR-1060-refuse-a-decision.md').allow).toBe(false)
  expect(judgePath('wiki\\adr\\cortex\\1060-refuse.md').allow).toBe(false)
  expect(judgePath('C:\\r\\wiki\\specs\\a.md').allow).toBe(false)
  expect(judgePath('C:\\r\\wiki\\README.md').allow).toBe(true)
  expect(judgePath('C:\\r\\docs\\adr\\README.md').allow).toBe(true)
  const refused = judgePath('C:\\r\\docs\\adr\\ADR-1060-x.md')
  expect(!refused.allow && refused.reason).toContain('C:\\r\\docs\\adr\\ADR-1060-x.md')
  expect(judgeCall('Edit', { file_path: 'C:\\r\\wiki\\lessons\\l.md' }).allow).toBe(false)
  expect(judgeCall('Write', { file_path: 'C:\\r\\src\\main.ts' }).allow).toBe(true)
  expect(judgeCall('NotebookEdit', { notebook_path: 'wiki\\adr\\n.md' }).allow).toBe(false)
})

test('a shell command that writes a Windows-spelled protected path is refused', () => {
  expect(judgeCall('Bash', { command: 'echo hi > docs\\adr\\ADR-1060-x.md' }).allow).toBe(false)
  expect(judgeCall('Bash', { command: 'type a.md > wiki\\adr\\cortex\\1060-x.md' }).allow).toBe(false)
  expect(judgeCall('Bash', { command: 'type docs\\adr\\ADR-1060-x.md' }).allow).toBe(true)
})

test('a worktree inside <repo>\\.claude\\worktrees\\ is allowed, one outside is refused with the path as typed', () => {
  const inside = 'C:\\Users\\t\\repo\\.claude\\worktrees\\x'
  expect(worktreeAddPath(`git worktree add ${inside}`)).toBe(inside)
  expect(judgeCall('Bash', { command: `git worktree add -b f ${inside} main` }).allow).toBe(true)
  expect(judgeCall('Bash', { command: 'git worktree add -b f C:\\Users\\t\\repo\\.Codex\\worktrees\\x' }).allow).toBe(true)
  const outside = judgeCall('Bash', { command: 'git worktree add -b f C:\\temp\\wt main' })
  expect(outside.allow).toBe(false)
  expect(!outside.allow && outside.rule).toBe('worktree-inside-repo')
  expect(!outside.allow && outside.reason).toContain('C:\\temp\\wt')
})
