import { expect, test } from 'claude-code/testing'

import { judgeCall, judgePath, placeWorktreeAdd, shellSteps, worktreeAddPath } from './guard'

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

// The command text sent to the shell, the path it names, and the directory the shell starts in.
const place = (command: string, cwd = '/s', agentId?: string): ReturnType<typeof placeWorktreeAdd> =>
  placeWorktreeAdd(command, worktreeAddPath(command) ?? '', cwd, agentId)
const unresolved = (command: string, cwd = '/s', agentId?: string): boolean => 'reason' in place(command, cwd, agentId)
const W = './.claude/worktrees/f'

test('a worktree path lands where the shell is when git runs, or the reason that is not known', () => {
  expect(place('git worktree add /r/.claude/worktrees/f')).toEqual({ path: '/r/.claude/worktrees/f' })
  expect(place('cd /x && git worktree add C:\\r\\.claude\\worktrees\\f')).toEqual({ path: 'C:\\r\\.claude\\worktrees\\f' })
  expect(place(`git worktree add ${W}`)).toEqual({ path: '/s/.claude/worktrees/f' })
  expect(place(`cd /r && git worktree add -b f ${W} main`)).toEqual({ path: '/r/.claude/worktrees/f' })
  expect(place(`cd sub && git worktree add ${W}`)).toEqual({ path: '/s/sub/.claude/worktrees/f' })
  expect(place(`cd /r && git worktree add ../r/.claude/worktrees/f`)).toEqual({ path: '/r/../r/.claude/worktrees/f' })
  // `;` runs git even when the cd failed; a subshell, pushd, a later cd, git -C, ~ and an unreadable session
  // directory each leave the start unknown.
  for (const unknown of [
    `cd /r; git worktree add ${W}`,
    `(cd /r && git worktree add ${W})`,
    `echo $(cd /r && git worktree add ${W} main)`,
    `pushd /r && git worktree add ${W}`,
    `true && cd /r && git worktree add ${W}`,
    `cd ~ && git worktree add ${W}`,
    `git -C /r worktree add ${W}`,
    'git worktree add ~/r/.claude/worktrees/f',
  ])
    expect('reason' in place(unknown)).toBe(true)
  expect(placeWorktreeAdd(`git worktree add ${W}`, W, undefined)).toEqual({
    reason: `the path ${W} could not be resolved: the session's directory could not be read`,
  })
})

// Round 1 of PR 30: a directory change is found on the text split at the shell's separators, not on whitespace.
test('a directory change glued to a separator is still a directory change', () => {
  expect(unresolved(`true;cd sub && git worktree add ../.claude/worktrees/w7 -b b7`)).toBe(true)
  expect(unresolved(`echo x &&cd sub && git worktree add ../.claude/worktrees/w11 -b b11`)).toBe(true)
  expect(unresolved(`true|cd sub && git worktree add ${W}`)).toBe(true)
  expect(unresolved(`echo $(cd sub) && git worktree add ${W}`)).toBe(true)
  expect(unresolved(`{ cd sub; git worktree add ${W}; }`)).toBe(true)
  expect(unresolved(`if cd sub; then git worktree add ${W}; fi`)).toBe(true)
  // The same words without a cd are not one.
  expect(place(`echo cd && git worktree add ${W}`)).toEqual({ path: '/s/.claude/worktrees/f' })
})

test('a leading cd keeps its place only when git runs once every command after it succeeded and none moves the directory', () => {
  // M9: `||` and a spaced `;` run git when the cd failed.
  expect(unresolved(`cd /r || git worktree add ${W}`)).toBe(true)
  expect(unresolved(`cd /r ; git worktree add ${W}`)).toBe(true)
  expect(unresolved(`cd /r & git worktree add ${W}`)).toBe(true)
  expect(unresolved(`cd /r && echo a || git worktree add ${W}`)).toBe(true)
  // M8: a second cd moves the shell again.
  expect(unresolved(`cd /a && cd b && git worktree add ${W}`)).toBe(true)
  expect(unresolved(`cd /a && git fetch && cd b && git worktree add ${W}`)).toBe(true)
  // M13: `cd -` goes to the previous directory.
  expect(unresolved(`cd - && git worktree add ${W}`)).toBe(true)
  expect(unresolved(`cd -P /r && git worktree add ${W}`)).toBe(true)
  expect(unresolved(`cd && git worktree add ${W}`)).toBe(true)
  expect(unresolved(`cd "" && git worktree add ${W}`)).toBe(true)
  expect(unresolved(`cd /r extra && git worktree add ${W}`)).toBe(true)
  expect(unresolved(`cd "my dir" && git worktree add ${W}`)).toBe(true)
  // Commands between the cd and git that move nothing leave the place known.
  expect(place(`cd /r && git fetch && git worktree add -b f ${W} origin/main`)).toEqual({ path: '/r/.claude/worktrees/f' })
  expect(place(`cd /r && git fetch --prune && npm ci && git worktree add ${W}`)).toEqual({ path: '/r/.claude/worktrees/f' })
  expect(unresolved(`cd /r && git fetch | cat && git worktree add ${W}`)).toBe(true)
  expect(unresolved(`cd /r && (git worktree add ${W})`)).toBe(true)
  // A command after the add, a `;` glued to the path and a redirect that holds an `&` change nothing.
  expect(place(`git worktree add ${W}; echo done`)).toEqual({ path: '/s/.claude/worktrees/f' })
  expect(place(`cd /r && git fetch 2>&1 && git worktree add ${W}`)).toEqual({ path: '/r/.claude/worktrees/f' })
})

test('a quoted path is resolved only when it has no space and its quote closes', () => {
  expect(unresolved('git worktree add "./.claude/worktrees/w 5" -b b5')).toBe(true)
  expect(unresolved("git worktree add '/r/.claude/worktrees/w 5'")).toBe(true)
  expect(unresolved('git worktree add "./.claude/worktrees/w5 -b b5')).toBe(true)
  expect(place('git worktree add "./.claude/worktrees/w5" -b b5')).toEqual({ path: '/s/.claude/worktrees/w5' })
  // The path itself is fine; a quote later in the command never closes, so the split cannot be trusted.
  expect(unresolved('git worktree add ./.claude/worktrees/w5 main "oops')).toBe(true)
  // A quoted branch with a space no longer makes the next word the path.
  expect(place('git worktree add -b "a b" ./.claude/worktrees/w5')).toEqual({ path: '/s/.claude/worktrees/w5' })
})

// The event of a subagent's loop carries `agentId`; the d.ts does not say which directory `$.session.cwd()` is
// for that loop's shell, so a path that depends on it is not known.
test('inside a subagent a path that depends on the session directory is not known', () => {
  expect(unresolved(`git worktree add ${W}`, '/s', 'a1')).toBe(true)
  expect(unresolved(`cd sub && git worktree add ${W}`, '/s', 'a1')).toBe(true)
  expect(place(`git worktree add /r/.claude/worktrees/f`, '/s', 'a1')).toEqual({ path: '/r/.claude/worktrees/f' })
  expect(place(`cd /r && git worktree add ${W}`, '/s', 'a1')).toEqual({ path: '/r/.claude/worktrees/f' })
  expect(place(`git worktree add ${W}`, '/s', undefined)).toEqual({ path: '/s/.claude/worktrees/f' })
})

test('text that only mentions the phrase is not an add; a command that may run its text is not text', () => {
  const mention = { mention: true }
  expect(place(`cd /r && git commit -m "docs: git worktree add ${W} is now registered"`)).toEqual(mention)
  expect(place(`git commit -m "git worktree add ${W}"`)).toEqual(mention)
  expect(place(`echo "git worktree add ${W}"`)).toEqual(mention)
  expect(place(`cd /r && grep -rn 'git worktree add' docs`)).toEqual(mention)
  expect(place(`cd /r && gh pr create --title t --body "$(cat <<'EOF'\nrun git worktree add ../r/.claude/worktrees/x main\nEOF\n)"`)).toEqual(mention)
  expect(place(`cd /r && cat > notes.md <<'EOF'\ngit worktree add ${W}\nEOF`)).toEqual(mention)
  // Not text: the shell runs it.
  expect(unresolved(`sh -c "git worktree add ${W}"`)).toBe(true)
  expect(unresolved(`bash <<'EOF'\ngit worktree add ${W}\nEOF`)).toBe(true)
  expect(unresolved(`echo hi; eval "git worktree add ${W}"`)).toBe(true)
  // A real add after the text is still the add.
  expect(place(`git commit -m "git worktree add ./a" && git worktree add ${W}`)).toEqual({ path: '/s/.claude/worktrees/f' })
  // A comment is not a command (and not text either: nothing is found, which is reported).
  expect(unresolved(`echo hi # git worktree add ${W}`)).toBe(true)
})

test('shellSteps splits at separators outside quotes and keeps a here-document with its command', () => {
  const split = (command: string): string[] => shellSteps(command).steps.map((step) => `${step.sep}|${step.words.join(' ')}`)
  expect(split('a;b&&c||d|e\nf')).toEqual(['|a', ';|b', '&&|c', '|||d', '||e', '\n|f'])
  expect(split("a \"b;c\" 'd&&e' f")).toEqual(['|a b;c d&&e f'])
  expect(split('(a) && $(b)')).toEqual(['(|a', '$(|b'])
  expect(shellSteps('echo "x').open).toBe(true)
  expect(shellSteps('echo "x"').open).toBe(false)
  const doc = shellSteps('cat <<-EOF\n\ta; b\n\tEOF\nnext')
  expect(doc.steps.map((step) => step.words.join(' '))).toEqual(['cat', 'next'])
  expect(doc.steps[0]?.body).toContain('a; b')
})
