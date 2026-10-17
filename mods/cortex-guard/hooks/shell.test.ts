import { expect, test } from 'claude-code/testing'

import { judgeCall, shellSteps } from './guard'

// Round 5 of PR 30 (B3, B4, B5 of the round-4 review). Every form was run under bash 5.3 and zsh 5.9 where it creates
// something (docs/verification/pr30-author-round5-2026-10-17.md), and judged at 25fe5ce.
const verdict = (command: string) => judgeCall('Bash', { command })
const refused = (command: string): boolean => !verdict(command).allow
const reason = (command: string): string => {
  const v = verdict(command)
  return v.allow ? '' : v.reason
}
const wordsOf = (command: string): string[] => shellSteps(command).steps.flatMap((step) => step.words)

// source: bash(1) QUOTING, zsh(1) QUOTING; measured with `printf '%s\n'` under both shells.
test('B3: an unquoted backslash makes the next character literal, whatever it is; in quotes it is kept', () => {
  expect(wordsOf('echo a/.\\./x')).toEqual(['echo', 'a/../x'])
  expect(wordsOf('echo a\\bc C:\\Users\\x \\\\host')).toEqual(['echo', 'abc', 'C:Usersx', '\\host'])
  expect(wordsOf('echo "a\\bc" \'a\\bc\'')).toEqual(['echo', 'a\\bc', 'a\\bc'])
  expect(wordsOf('echo a\\')).toEqual(['echo', 'a\\'])
})

test('B3: a path whose `.\\.` the shell reads as `..` leaves the worktree root and is refused', () => {
  for (const command of [
    'git worktree add .claude/worktrees/a/.\\./.\\./.\\./.\\./x1',
    'git worktree add ./.claude/worktrees/.\\./x2',
    'git worktree add .claude/worktrees/a/\\.\\./\\.\\./x',
    'git worktree add C:\\Users\\t\\repo\\.claude\\worktrees\\x',
  ])
    expect([command, refused(command)]).toEqual([command, true])
  expect(refused('git worktree add .claude/worktrees/a\\b')).toBe(false)
  expect(refused('git worktree add "C:\\Users\\t\\repo\\.claude\\worktrees\\x"')).toBe(false)
})

test('B4: the value of an assignment in the command is read as a value: a variable that splits into an add is a doubt', () => {
  for (const command of [
    'G=git; WA="worktree add"; $G $WA /tmp/o/x3',
    'G=git; WTADD="worktree add"; $G $WTADD /tmp/o/wa',
    "WA='worktree add' $G $WA /tmp/o/x",
    'export WA="worktree add"; git $WA /tmp/o/x',
    'G=git; WA="worktree add"; "$G" $WA /tmp/o/x',
    "sh -c 'WA=\"worktree add\"; $G $WA /tmp/o/x'",
    // A variable assigned git and worktree, used as the command name before add (bash splits it).
    "GW='git worktree'; $GW add /tmp/o/gw",
    "GW='git worktree'; A=add; $GW $A /tmp/o/gw",
    "export GW='git worktree'; sh -c '$GW add /tmp/o/gw'",
  ])
    expect([command, refused(command)]).toEqual([command, true])
  expect(reason('G=git; WA="worktree add"; $G $WA /tmp/o/x')).toContain('worktree add')
  for (const command of [
    'MSG="please add a test"; echo $MSG',
    'NAME="my worktree"; mkdir -p "$NAME"',
    'A="a b"; B=c; echo $A $B',
    "GW='git worktree'; $GW list",
    'GIT=git; $GIT add -A',
  ])
    expect([command, refused(command)]).toEqual([command, false])
})

// Only text a shell runs, or text that may reach one, is read as commands: a quoted argument of any other command is
// not.
test('B5: three expansions in a quoted argument of a command that runs no text are no command', () => {
  for (const command of [
    'rm "$A $B $C"',
    'curl -d "$USER $HOST $PORT" http://x',
    'ssh h "$X $Y $Z"',
    'echo "$A $B $C"; npm test',
    'python3 tool.py --msg "$A $B $C"',
    'echo "$A $B $C" | python3 x.py',
    'git push origin "$A $B $C"',
    'git commit -m "$A $B $C"',
  ])
    expect([command, refused(command)]).toEqual([command, false])
})

test('B5: the same expansions in text a shell runs, or that reaches one, are still a doubt', () => {
  for (const command of [
    'echo "$G $W $A /tmp/o/p" | sh',
    "sh -c '$G $W $A /tmp/o/p'",
    "bash -c 'G=git; W=worktree; $G $W add /tmp/o/p'",
    "echo '$G $W $A /tmp/o/p' > s.sh; sh s.sh",
    "echo '$G $W $A /tmp/o/p' > s.sh; source s.sh",
    'cat <<EOF | bash\n$G $W $A /tmp/o/p\nEOF',
    "bash <<'EOF'\n$G $W $A /tmp/o/p\nEOF",
    "sudo bash -c '$G $W $A /tmp/o/p'",
    "/bin/sh -c '$G $W $A /tmp/o/p'",
    // A phrase that spells the add outright is refused wherever it is, ssh included.
    "ssh h 'git worktree add /tmp/o/p'",
  ])
    expect([command, refused(command)]).toEqual([command, true])
})

// source: bash(1) SHELL BUILTIN COMMANDS: eval joins its arguments with blanks and reads the result.
test('eval reads its arguments joined, so a quote left in one of them is a quote of the shell text', () => {
  for (const command of [
    "eval git worktree '\"add\"' /tmp/o/x5",
    'eval git worktree \\"add\\" /tmp/o/e2',
    "eval git worktree \"'add'\" /tmp/o/e3",
  ])
    expect([command, refused(command)]).toEqual([command, true])
  for (const command of ['eval "$(ssh-agent -s)"', 'eval $(brew shellenv)', 'eval "$(direnv export bash)"'])
    expect([command, refused(command)]).toEqual([command, false])
})

test('git config: the value of an alias key is what decides, not another word that is expanded', () => {
  for (const command of ['git config --file=$CFG alias.co checkout', 'git config --global alias.co checkout'])
    expect([command, refused(command)]).toEqual([command, false])
  for (const command of ['git config --file=$CFG alias.wt worktree', 'git config alias.wt "$V"', "git config --global alias.wt '!git worktree'"])
    expect([command, refused(command)]).toEqual([command, true])
  expect(reason('git config --file=$CFG alias.wt worktree')).toContain('alias.wt worktree')
  expect(reason('git config --file=$CFG alias.wt worktree')).not.toContain('--file')
})
