import { expect, test } from 'claude-code/testing'

import { judgeCall, shellSteps } from './guard'

// Round 3 of PR 30: the refusal reads the command split into steps, the same analysis the registration reads.
// Every shape here was measured against 1952ae4 (the whitespace tokens) and gave the other answer.
const refused = (command: string): boolean => !judgeCall('Bash', { command }).allow
const W = './.claude/worktrees/a'

test('an add whose text can reach a shell is refused: where it lands cannot be read from the command', () => {
  for (const command of [
    `echo '${W}' | xargs git worktree add`,
    `echo 'git worktree add ${W}' | sh`,
    `printf 'git worktree add ${W}' | sh`,
    `echo 'git worktree add ${W}' | zsh`,
    `echo 'git worktree add ${W}' | bash -s`,
    `echo 'git worktree add ${W}' > s.sh; sh s.sh`,
    `echo 'git worktree add ${W}' > s.sh && source s.sh`,
    `bash <<'EOF'; echo done\ngit worktree add ${W}\nEOF`,
    `sh <<EOF | cat\ngit worktree add ${W}\nEOF`,
    `bash <<< "git worktree add ${W}"`,
    `sh -c "git worktree add ${W}"`,
    `eval "git worktree add ${W}"`,
    `python3 -c "import os; os.system('git worktree add ${W}')"`,
    `bash <(echo 'git worktree add ${W}')`,
    `{ echo 'git worktree add ${W}'; } | sh`,
    `cmd="git worktree add ${W}"; $cmd`,
    `$(echo git) worktree add ${W}`,
    `cat <<EOF\n$(git worktree add ${W})\nEOF`,
    `git commit -m "git worktree add ${W}" && npm test`,
  ])
    expect([command, refused(command)]).toEqual([command, true])
})

test('an add the refusal judged is the add the shell runs: every add, glued or nested, is judged', () => {
  for (const command of [
    // N2: an in-root mention first, the real add outside after it.
    `echo "git worktree add ${W}" ; git worktree add -b b /r/../out`,
    // N3: `git` glued to a separator, in a substitution, in backticks, in a subshell.
    'true;git worktree add /tmp/evil',
    'true&&git worktree add /tmp/evil',
    'cd /r&&git worktree add /tmp/evil',
    'echo $(git worktree add /tmp/evil)',
    'echo "$( git worktree add /tmp/evil)"',
    'echo `git worktree add /tmp/evil`',
    '(git worktree add /tmp/evil) && false',
    'git commit -m "$( git worktree add /tmp/evil)"',
    // N5: the second add is judged too.
    `git worktree add ${W} && git worktree add /tmp/evil`,
    // The command word spelled with an escape or quotes is still git.
    '\\git worktree add /tmp/evil',
    'g"i"t worktree add /tmp/evil',
    'exec git worktree add /tmp/evil',
    'FOO=1 git worktree add /tmp/evil',
    // The subcommand or the verb spelled by the shell: no phrase in the text, an add when it runs.
    'W=worktree; git $W add /tmp/evil',
    'git ${W} add /tmp/evil',
    'A=add; git worktree $A /tmp/evil',
    'G=git; W=worktree; $G $W add /tmp/evil',
    'git {worktree,} add /tmp/evil',
  ])
    expect([command, refused(command)]).toEqual([command, true])
})

// git-worktree(1) as git 2.50 prints it: `[--lock [--reason <string>]] [--orphan] [(-b | -B) <new-branch>] <path>`.
test('the path is the first word git reads as the path: --orphan takes no value, --reason and -b do', () => {
  expect(refused('git worktree add --orphan /tmp/evil')).toBe(true)
  expect(refused(`git worktree add --lock --reason ${W} /tmp/evil`)).toBe(true)
  expect(refused(`git worktree add --rea ${W} /tmp/evil`)).toBe(true)
  expect(refused(`git worktree add -fb ${W} /tmp/evil`)).toBe(true)
  expect(refused(`git worktree add -b${W} /tmp/evil`)).toBe(true)
  expect(refused(`git worktree add -- /tmp/evil`)).toBe(true)
  // After `--` a word that starts with `-` is the path (git creates `-evil` where the shell is).
  expect(refused(`git worktree add -- -evil`)).toBe(true)
  // An escaped command name is the command: an in-root add spelled `\git` is an add, not text a runner carries.
  expect(refused(`\\git worktree add ${W}`)).toBe(false)
  expect(refused('git worktree add 2>/dev/null /tmp/evil')).toBe(true)
  expect(refused(`git worktree add --orphan -b o ${W}`)).toBe(false)
  expect(refused(`git worktree add ${W} > /tmp/log 2>&1`)).toBe(false)
})

test('a path inside the worktree root is allowed however it is spelled; one that leaves it is not', () => {
  // Measured on 2026-10-17: the first was refused from the repo root, the absolute spelling passed.
  expect(refused('git worktree add -b fix/x .claude/worktrees/guard-r3 origin/fix/x')).toBe(false)
  expect(refused('git worktree add .Codex/worktrees/c')).toBe(false)
  expect(refused('git worktree add ../.claude/worktrees/w7 -b b7')).toBe(false)
  expect(refused('git worktree add .claude/worktrees/../../tmp/evil')).toBe(true)
  expect(refused('git worktree add /r/.claude/worktrees/$NAME')).toBe(true)
  expect(refused('git worktree add /r/.claude/worktrees/')).toBe(true)
})

test('text that names the phrase and that no shell runs is still allowed', () => {
  for (const command of [
    `git commit -m "docs: git worktree add ${W} is now registered"`,
    `cd /r && git add -A && git commit -m "$(cat <<'EOF'\nrun git worktree add ${W} main\nEOF\n)"`,
    `gh pr create --title t --body "$(cat <<'EOF'\n1) run git worktree add ../r/.claude/worktrees/x main\nEOF\n)"`,
    `cd /r && grep -rn 'git worktree add' docs`,
    `rg 'worktree add' mods | head -5`,
    `git log --grep 'worktree add' --oneline`,
    `cat > notes.md <<'EOF'\ngit worktree add ${W}\nEOF`,
    `echo hi # git worktree add /tmp/evil`,
    // A command named by a variable whose next words cannot spell an add.
    '"$PY" -m pytest -q',
    'git log --oneline -3',
  ])
    expect([command, refused(command)]).toEqual([command, false])
})

test('a here-document body belongs to the command that opened it, wherever that command is on its line', () => {
  const owner = (command: string): string =>
    shellSteps(command).steps.find((step) => step.body.includes('BODY'))?.words.join(' ') ?? ''
  expect(owner("bash <<'EOF'; echo done\nBODY\nEOF")).toBe('bash')
  expect(owner('sh <<EOF | cat\nBODY\nEOF')).toBe('sh')
  expect(owner("cat <<'A' && tee x <<'B'\nBODY\nA\nother\nB")).toBe('cat')
  expect(owner("x=1; bash <<\\EOF\nBODY\nEOF")).toBe('bash')
})

// Round 4 of PR 30. B1: text a shell runs is read with the same split as the command, its quotes resolved, so a
// verb quoted, escaped or continued inside it is the verb. Each form was allowed at 9f1b4b0 with nothing to register
// (the review created q1 and q5 with real git under zsh and bash).
test('an add spelled with quotes or escapes inside text a shell runs is refused', () => {
  const o = '/tmp/o'
  for (const command of [
    `sh -c 'git worktree "add" ${o}/q1'`,
    `eval 'git worktree "add" ${o}/q2'`,
    `echo 'git worktree "add" ${o}/q5' | sh`,
    `sh -c 'git worktree \\add ${o}/a'`,
    `sh -c 'git "worktree" add ${o}/b'`,
    `sh -c "git wor''ktree add ${o}/c"`,
    `sh -c 'git worktree \\\nadd ${o}/d'`,
    `bash -c 'git worktree a\\dd ${o}/q3'`,
    `sh -c 'git worktree "$1" "$2"' _ add ${o}/q6`,
    `sh -c "bash -c 'git worktree \\"add\\" ${o}/n'"`,
    `bash <<'EOF'\ngit worktree "add" ${o}/h\nEOF`,
    `sh -c 'git worktree "add" ${W}'`,
  ])
    expect([command, refused(command)]).toEqual([command, true])
})

// B2: a command named by a variable is a doubt only when its words read like a worktree add. Three of these are
// from past sessions (1316 commands replayed by the review); all were allowed at b31e910 and refused at 9f1b4b0.
test('a command named by a variable whose words do not read like a worktree add is allowed', () => {
  for (const command of [
    '$P/run.sh $P/check.py',
    '"$PY" "$SCRIPT"',
    '$EDITOR {a,b}.txt',
    '"$VENV/bin/python" tools/*.py',
    'cd /r/.claude/worktrees/x && P=/p && $P/hooks/run-python.sh $P/hooks/lib/staged_checks.py $P "$(pwd)"',
    '$CARGO_TARGET_DIR/release/examples/ts_probe $s',
  ])
    expect([command, refused(command)]).toEqual([command, false])
  for (const command of ['G=git; $G worktree add /tmp/evil', '$G worktree $A /tmp/evil', '$G -C /r $W add /tmp/evil', '$G $W "add" x'])
    expect([command, refused(command)]).toEqual([command, true])
})

test('the reason of a refusal in doubt says the command may run an add, not that it does', () => {
  for (const command of ['git $SUBCMD', 'G=git; W=worktree; $G $W add x', `sh -c 'git worktree "add" ${W}'`]) {
    const verdict = judgeCall('Bash', { command })
    expect([command, verdict.allow, verdict.allow ? '' : verdict.reason.startsWith('the command may run a git worktree add')]).toEqual([command, false, true])
  }
})

// git-config(1): `-c <name>=<value>`; a key such as core.pager or alias.* names a program git runs, user.name does
// not. Keys are case-insensitive.
test('git -c with a key that runs nothing keeps a commit message a mention', () => {
  const m = `commit -m "docs: git worktree add ${W}"`
  expect(refused(`git -c user.name=x -c user.email=y ${m}`)).toBe(false)
  expect(refused(`git -c User.Email=y ${m}`)).toBe(false)
  expect(refused(`git --config-env user.name=N ${m}`)).toBe(false)
  expect(refused(`git --config-env=user.name=N ${m}`)).toBe(false)
  expect(refused(`git -c core.pager=sh ${m}`)).toBe(true)
  expect(refused(`git --config-env=core.pager=PG ${m}`)).toBe(true)
  expect(refused(`git -c alias.ci=!sh ${m}`)).toBe(true)
  // An alias set by -c may be worktree add under another name (created /o/al with real git at 9f1b4b0, unseen).
  expect(refused('git -c alias.wt=worktree wt add /tmp/o/al')).toBe(true)
  expect(refused('git -c Alias.wt=worktree wt add ./.claude/worktrees/a')).toBe(true)
})

// The code review of this round: a step of text a shell runs gets the same check as a step of the command, and an
// alias defined in the command, ANSI-C quoting and signing are read.
test('text a shell runs is judged step by step like the command; aliases and $\'...\' are read', () => {
  for (const command of [
    'G=git; W=worktree; A=add; $G $W $A /tmp/evil',
    "sh -c 'git -c alias.wt=worktree wt add /tmp/evil'",
    "sh -c 'git $SUB /tmp/evil'",
    "sh -c 'G=git; W=worktree; $G $W add /tmp/evil'",
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.wt GIT_CONFIG_VALUE_0=worktree git wt add /tmp/evil',
    'git config alias.wt worktree && git wt add /tmp/evil',
    'git --config-env=alias.wt=WT wt add /tmp/evil',
    "sh -c $'git worktree \\x61dd /tmp/evil'",
    `git -c commit.gpgsign=true commit -m "docs: git worktree add ${W}"`,
  ])
    expect([command, refused(command)]).toEqual([command, true])
  // An alias to another command defines no add.
  expect(refused('git config --global alias.co checkout')).toBe(false)
  expect(refused('git -c alias.co=checkout co main')).toBe(false)
  // A mention nested past the depth the split reads still has its path judged.
  const q = (t: string): string => `'${t.replace(/'/g, "'\\''")}'`
  let text = 'git worktree add /tmp/evil'
  for (let k = 0; k < 6; k++) text = `echo ${q(text)}`
  expect(refused(text)).toBe(true)
})

test('a pattern that is not a shell add stays text: its words, split as a shell would, name no add', () => {
  expect(refused("sed -n '/git worktree add/p' README.md")).toBe(false)
  // Prose with `worktree` before a variable is not git's verb (from a past session: the echo reached python3).
  expect(refused('python3 h.py --path $P; echo "- red worktree $P (detached, registered)" >> notes.md')).toBe(false)
})
