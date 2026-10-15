import { expect, test } from 'claude-code/testing'

import type { OutcomeEvent } from '../types'
import { MAX_EVENTS, type BashResult, addFriction, bodyFileOf, eventsOfBash, exitOk, foldEvent, liveFrictionOf, samePr, segmentsOf, testLabel, verdictOf } from './events'

const ok: BashResult = { text: '', result: { stdout: '', stderr: '' } }
const failed = (code: number): BashResult => ({ isError: true, text: `Exit code ${code}\nboom` })
const run = (command: string, res: BashResult = ok, extra: { agent?: string; bodyFile?: string | null } = {}) => eventsOfBash({ command, at: 10, res, ...extra })

test('a chain is split at its operators, not inside quotes or heredocs', () => {
  expect(segmentsOf('git add -A && git commit -m "a && b; c" && git push').map((s) => s.text)).toEqual(['git add -A', 'git commit -m "a && b; c"', 'git push'])
  const heredoc = 'git commit -m "$(cat <<\'EOF\'\nfix: x && y\ngit push\nEOF\n)" && git push'
  expect(segmentsOf(heredoc).map((s) => s.text.split('\n')[0])).toEqual(['git commit -m "$(cat <<\'EOF\'', 'git push'])
  expect(segmentsOf('claude plugin test 2>&1 | tail -5')).toEqual([
    { text: 'claude plugin test 2>&1', piped: true },
    { text: 'tail -5', piped: false },
  ])
})

test('a commit is read from the command and its sha from the result line or gitOperation; both agreeing is src both', () => {
  const byLine = run('git commit -m "x"', { text: '[feat/x 1a2b3c4] x\n 1 file changed' })
  expect(byLine).toEqual([{ at: 10, kind: 'commit', src: 'command', sha: '1a2b3c4', ok: true }])
  const byOp = run('git commit -m "x"', { text: 'done', result: { gitOperation: { commit: { sha: 'ABCDEF1234', kind: 'committed' } } } })
  expect(byOp[0]).toMatchObject({ kind: 'commit', src: 'both', sha: 'abcdef1234' })
  expect(run('git commit --amend --no-edit', { text: '[feat/x 99999999] x' })[0]).toMatchObject({ label: 'amended' })
})

test('a script whose result carries a gitOperation commit is still seen', () => {
  const e = run('./scripts/ship.sh', { result: { gitOperation: { commit: { sha: 'deadbeef1' } } } })
  expect(e).toEqual([{ at: 10, kind: 'commit', src: 'git-operation', sha: 'deadbeef1', ok: true }])
})

test('commit then push in one chain: both events, attributed to the agent', () => {
  const e = run('git add -A && git commit -m "m" && git push -u origin feat/x', { text: '[feat/x 1111111] m' }, { agent: 'ag-1' })
  expect(e.map((x) => [x.kind, x.agent])).toEqual([
    ['commit', 'ag-1'],
    ['push', 'ag-1'],
  ])
})

test('a test run reports its exit status: 0 true, non-zero false, piped or interrupted null', () => {
  expect(run('cd mods/a && claude plugin test')).toEqual([{ at: 10, kind: 'test', src: 'command', label: 'claude plugin test', ok: true }])
  expect(run('uv run pytest tests_py/ -x', failed(1))[0]).toMatchObject({ label: 'pytest', ok: false })
  expect(run('bun test', failed(2))[0]).toMatchObject({ label: 'bun test', ok: false })
  expect(run('claude plugin test 2>&1 | tail -15')[0]).toMatchObject({ label: 'claude plugin test', ok: null })
  expect(run('set -o pipefail; npm test | tail')[0]).toMatchObject({ label: 'npm test', ok: true })
  expect(run('node --test codex/tests/*.test.mjs', { isError: true, text: 'The command timed out' })[0]).toMatchObject({ ok: null })
  expect(run('sh scripts/check-shared.sh', failed(1))[0]).toMatchObject({ label: 'gate:check-shared.sh', ok: false })
  expect(run('npx -y -p typescript tsc -p . --noEmit')[0]).toMatchObject({ label: 'tsc' })
  expect(exitOk({ isError: true, text: 'Exit code 0' })).toBe(true)
})

test('a commit message that names a test command is no test run', () => {
  const e = run('git commit -m "fix: pytest flake"', { text: '[main 1234567] fix' })
  expect(e.map((x) => x.kind)).toEqual(['commit'])
  expect(testLabel('echo hello')).toBeNull()
})

test('a failed chain claims no state change: only its test runs, and what gitOperation confirms', () => {
  expect(run('git add . && git commit -m x && git push', failed(1))).toEqual([])
  const e = run('git commit -m x && claude plugin test', { isError: true, text: 'Exit code 1', result: { gitOperation: { commit: { sha: 'abcabca1' } } } })
  expect(e.map((x) => [x.kind, x.ok])).toEqual([
    ['test', false],
    ['commit', true],
  ])
})

test('revert names the sha; reset reaches back n commits only for HEAD~n and HEAD^; an unstage is neither', () => {
  expect(run('git revert 1a2b3c4d --no-edit')[0]).toMatchObject({ kind: 'revert', sha: '1a2b3c4d' })
  expect(run('git revert HEAD')[0]).toMatchObject({ kind: 'revert', sha: 'head' })
  expect(run('git reset --hard HEAD~2')[0]).toMatchObject({ kind: 'reset', back: 2, sha: 'head~2' })
  expect(run('git reset --soft HEAD^')[0]).toMatchObject({ kind: 'reset', back: 1 })
  expect(run('git reset --hard abcdef1')[0]).toMatchObject({ kind: 'reset', sha: 'abcdef1' })
  expect(run('git reset HEAD src/a.ts')).toEqual([])
})

test('a pull request is created, merged, closed; its number from the URL, the argument or gitOperation', () => {
  const created = run('gh pr create --title t --body b', { text: 'https://github.com/cdeust/claude-mods/pull/23\n' })
  expect(created[0]).toMatchObject({ kind: 'pr-create', pr: 'cdeust/claude-mods#23', ok: true })
  expect(run('gh pr merge 23 --squash --delete-branch')[0]).toMatchObject({ kind: 'pr-merge', pr: '#23' })
  expect(run('gh pr merge https://github.com/cdeust/claude-mods/pull/23')[0]).toMatchObject({ pr: 'cdeust/claude-mods#23' })
  expect(run('gh pr close 9 --repo a/b')[0]).toMatchObject({ kind: 'pr-close', pr: 'a/b#9' })
  expect(run('gh pr merge', { result: { gitOperation: { pr: { number: 7, action: 'merged' } } } })[0]).toMatchObject({ pr: '#7', src: 'both' })
  expect(samePr('#23', 'cdeust/claude-mods#23')).toBe(true)
  expect(samePr('a/b#23', 'c/d#23')).toBe(false)
  expect(samePr(undefined, '#1')).toBe(false)
})

test('a verdict is a gh pr comment whose body opens ZETETIC-REVIEW: APPROVE or REQUEST-CHANGES, the head sha on the next line', () => {
  expect(verdictOf('ZETETIC-REVIEW: APPROVE\n705020b1\nlooks fine')).toEqual({ verdict: 'approve', head: '705020b1' })
  expect(verdictOf('"ZETETIC-REVIEW: REQUEST-CHANGES\n\nhead: ABC1234567"')).toEqual({ verdict: 'changes', head: 'abc1234567' })
  expect(verdictOf('ZETETIC-REVIEW: APPROVE')).toEqual({ verdict: 'approve' })
  expect(verdictOf('thanks, merging')).toBeNull()
  const heredoc = "gh pr comment 23 --body \"$(cat <<'EOF'\nZETETIC-REVIEW: APPROVE\n705020b1\nbody\nEOF\n)\""
  expect(run(heredoc)[0]).toMatchObject({ kind: 'verdict', pr: '#23', verdict: 'approve', head: '705020b1' })
  expect(run('gh pr comment 23 --body "ZETETIC-REVIEW: REQUEST-CHANGES\\nabcdef12"')[0]).toMatchObject({ verdict: 'changes' })
  expect(run('gh pr comment 23 --body "thanks"')).toEqual([])
})

test('a review body kept in a file is read by the register: its text decides, an unreadable file is an unknown verdict', () => {
  const cmd = 'gh pr comment 23 --body-file /tmp/review.md'
  expect(bodyFileOf(cmd)).toBe('/tmp/review.md')
  expect(bodyFileOf('gh pr comment 23 -F -')).toBeNull()
  expect(bodyFileOf('git commit -F msg.txt')).toBeNull()
  expect(run(cmd, ok, { bodyFile: 'ZETETIC-REVIEW: APPROVE\n705020b1\n' })[0]).toMatchObject({ verdict: 'approve', head: '705020b1' })
  expect(run(cmd, ok, { bodyFile: null })[0]).toMatchObject({ kind: 'verdict', verdict: 'unknown' })
  expect(run(cmd, ok, { bodyFile: 'just a note' })).toEqual([])
})

test('a refused call shows no event; a command that is not a string shows none', () => {
  expect(run('git commit -m x', { deny: 'no' })).toEqual([])
  expect(eventsOfBash({ command: undefined as never, at: 1, res: ok })).toEqual([])
})

test('repeats fold into n; past MAX_EVENTS they are counted, not kept', () => {
  const t: OutcomeEvent = { at: 1, kind: 'test', src: 'command', label: 'bun test', ok: false }
  let list = { events: [] as OutcomeEvent[], dropped: 0 }
  for (let i = 0; i < 5; i++) list = foldEvent(list, t)
  expect(list.events).toEqual([{ ...t, n: 5 }])
  for (let i = 0; i < MAX_EVENTS + 3; i++) list = foldEvent(list, { ...t, sha: String(i), kind: 'commit' })
  expect(list.events.length).toBe(MAX_EVENTS)
  expect(list.dropped).toBe(4)
})

test('a live friction is a refusal or a closed-rule tool error; a Bash exit or a success is none; secrets are masked', () => {
  expect(liveFrictionOf('Bash', failed(1))).toBeNull()
  expect(liveFrictionOf('Bash', ok)).toBeNull()
  expect(liveFrictionOf('Write', { deny: '[decision-gate] BLOCKED: x.ts would add 12 lines.' })).toEqual({ kind: 'harness-refusal', signature: '[decision-gate] BLOCKED: x.ts would add N lines.' })
  expect(liveFrictionOf('Edit', { isError: true, text: 'File has not been read yet.' })).toEqual({ kind: 'tool-misuse', signature: 'File has not been read yet.' })
  expect(liveFrictionOf('mcp__x__y', { isError: true, text: 'connection refused' })?.kind).toBe('mcp-failure')
  const masked = liveFrictionOf('Write', { deny: 'denied: token=ghp_abcdefghijklmnop1234' })
  expect(masked?.signature).not.toContain('ghp_')
  let list = addFriction([], masked!)
  list = addFriction(list, masked!)
  expect(list).toEqual([{ ...masked!, count: 2 }])
})
