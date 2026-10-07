import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Wiring tests: the calls go through the engine, the guard hook and its .catch, not judgeCall alone.

const stubs = (on: Parameters<TestBody>[1], toasts: string[]) => {
  mock.clock(on, { now: 1_000_000 })
  on('fs.stat', ($, e) => ({ value: { kind: 'file', size: 1, mtimeMs: 0, realPath: e.path } as never }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'test-session' }))
  on('fs.read', () => ({ value: '{}' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } as never }))
  on('tool.call', () => ({ result: 'ran' }))
}

test('an Edit to a canonical wiki page is refused and nothing runs', async ($, on) => {
  const toasts: string[] = []
  stubs(on, toasts)
  const out = await $.tool.call({
    tool: 'Edit',
    file_path: '/r/wiki/adr/cortex/1060-x.md',
    old_string: 'a',
    new_string: 'b',
  })
  expect(out.deny).toMatch(/wiki-write-only/)
  expect(out.deny).toMatch(/wiki_write/)
  expect(toasts).toEqual(['refused Edit: wiki-write-only'])
})

test('a Write to the generated ADR mirror is refused', async ($, on) => {
  stubs(on, [])
  const out = await $.tool.call({ tool: 'Write', file_path: 'docs/adr/ADR-1062-x.md', content: 'x' })
  expect(out.deny).toMatch(/read-only mirror/)
})

test('a path whose real location is a wiki page is refused even under another spelling', async (
  $,
  on,
) => {
  mock.clock(on, { now: 1_000_000 })
  on('fs.stat', () => ({
    value: { kind: 'file', size: 1, mtimeMs: 0, realPath: '/r/wiki/specs/plan.md' } as never,
  }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: 'ran' }))
  const out = await $.tool.call({ tool: 'Edit', file_path: '/r/link.md', old_string: 'a', new_string: 'b' })
  expect(out.deny).toMatch(/canonical wiki page/)
})

// Registration through disk_hygiene.py is a background step; off here so the test owns every call.
test(
  'git worktree add outside the repo is refused; inside it runs',
  { options: { hygiene_script: '' } },
  async ($, on) => {
  stubs(on, [])
  const bad = await $.tool.call({ tool: 'Bash', command: 'git worktree add -b f /tmp/wt main' })
  expect(bad.deny).toMatch(/worktree-inside-repo/)
  const ok = await $.tool.call({
    tool: 'Bash',
    command: 'git worktree add -b f /r/.claude/worktrees/f main',
  })
  expect(ok.deny).toBe(undefined)
  expect(ok.result).toBe('ran')
  },
)

test('an ordinary edit and a read-only command go through', async ($, on) => {
  stubs(on, [])
  const edit = await $.tool.call({ tool: 'Edit', file_path: '/r/src/a.py', old_string: 'a', new_string: 'b' })
  expect(edit.result).toBe('ran')
  const ls = await $.tool.call({ tool: 'Bash', command: 'ls wiki/adr' })
  expect(ls.result).toBe('ran')
})

test('a guard whose real-path read fails still refuses a protected spelling', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('fs.stat', () => ({ deny: 'no such file' }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: 'ran' }))
  const out = await $.tool.call({ tool: 'Write', file_path: 'wiki/lessons/new.md', content: 'x' })
  expect(out.deny).toMatch(/wiki-write-only/)
})
