import { expect, test } from 'claude-code/testing'

import { LOOPS_CAP, emptyPhases, erred, finished, isFileReadStep, isMainImplementation, spawned, startTurn, stepPhase, stepped, toolPhase, typePhase } from './phases'

const use = (name: string, input: unknown = {}) => ({ name, input })

test('an agent type names its phase by role; an unknown type names none', () => {
  expect(typePhase('Plan')).toBe('planning')
  expect(typePhase('Explore')).toBe('analysis')
  expect(typePhase('zetetic-team-subagents:architect')).toBe('design')
  expect(typePhase('zetetic-team-subagents:engineer')).toBe('implementation')
  expect(typePhase('zetetic-team-subagents:test-engineer')).toBe('test')
  expect(typePhase('zetetic-team-subagents:code-reviewer')).toBe('review')
  expect(typePhase('zetetic-team-subagents:advisor')).toBe('review')
  expect(typePhase('zetetic-team-subagents:memory-writer')).toBe('report')
  expect(typePhase('general-purpose')).toBe(undefined)
  expect(typePhase('brand-voice:discover-brand')).toBe(undefined)
})

test('a tool call names the phase of what it does', () => {
  expect(toolPhase('Read', { file_path: '/r/a.ts' })).toBe('analysis')
  expect(toolPhase('TaskCreate', {})).toBe('planning')
  expect(toolPhase('Edit', { file_path: '/r/src/a.ts' })).toBe('implementation')
  expect(toolPhase('Edit', { file_path: '/r/hooks/a.test.ts' })).toBe('test')
  expect(toolPhase('Write', { file_path: '/r/docs/adr/ADR-12.md' })).toBe('design')
  expect(toolPhase('Bash', { command: 'claude plugin test' })).toBe('test')
  expect(toolPhase('Bash', { command: 'pytest tests_py/core' })).toBe('test')
  expect(toolPhase('Bash', { command: "python3 -c 'import calc; assert calc.add(2,3)==5'" })).toBe('test')
  expect(toolPhase('Bash', { command: 'npx -y -p typescript tsc -p . --noEmit' })).toBe('verification')
  expect(toolPhase('Bash', { command: 'gh pr diff 10' })).toBe('review')
  expect(toolPhase('Bash', { command: 'git commit -m x && git push' })).toBe('report')
  expect(toolPhase('Bash', { command: 'ls -la' })).toBe('analysis')
  expect(toolPhase('Bash', { command: 'cd mods/x && claude plugin test 2>&1 | tail -3' })).toBe('test')
  expect(toolPhase('Bash', { command: 'UV_NO_SYNC=1 pytest -q' })).toBe('test')
  expect(toolPhase('Bash', { command: 'grep -rn pytest src' })).toBe('analysis')
  expect(toolPhase('Bash', { command: 'git commit -m "fix tsc"' })).toBe('report')
  expect(toolPhase('Bash', { command: 'gh pr create --body "ran pytest"' })).toBe('report')
  expect(toolPhase('Bash', { command: 'git diff --stat' })).toBe('analysis')
  expect(toolPhase('Bash', { command: "python3 - <<'EOF'" })).toBe('implementation')
  expect(toolPhase('Agent', { subagent_type: 'zetetic-team-subagents:code-reviewer' })).toBe('review')
  expect(toolPhase('Skill', { skill: 'superpowers:brainstorming' })).toBe('planning')
  expect(toolPhase('mcp__plugin_hypermnesia-mcp_cortex__recall', {})).toBe('analysis')
  expect(toolPhase('mcp__plugin_hypermnesia-mcp_cortex__remember', {})).toBe('report')
  expect(toolPhase('mcp__plugin_ai-architect-mcp-codebase_ai-architect__verify_semantic_diff', {})).toBe('verification')
  expect(toolPhase('SendMessage', {})).toBe(undefined)
})

test('a step is in the furthest phase of its calls; answering with no call is the report', () => {
  expect(stepPhase([use('Read'), use('Edit', { file_path: '/r/a.ts' })], '')).toBe('implementation')
  expect(stepPhase([use('Bash', { command: 'claude plugin test' }), use('Read')], '')).toBe('test')
  expect(stepPhase([], 'Done: the fix is merged.')).toBe('report')
  expect(stepPhase([], '')).toBe(undefined)
  expect(stepPhase([use('SendMessage')], '')).toBe(undefined)
})

const step = (loopId: string, phase: Parameters<typeof stepped>[1]['phase'], advisorCalls = 0, at = 2) => ({
  loopId,
  model: 'claude-opus-5-5',
  effort: 'medium',
  phase,
  fileRead: false,
  advisorCalls,
  at,
})

test("main moves with its steps, consecutive steps in one phase make one run", () => {
  let s = startTurn(emptyPhases(), 't1', 'claude-opus-5-5', 1)
  s = stepped(s, step('main', 'analysis'))
  s = stepped(s, step('main', 'analysis'))
  s = stepped(s, step('main', undefined))
  s = stepped(s, step('main', 'implementation'))
  const main = s.loops.find((l) => l.id === 'main')
  expect(main?.phase).toBe('implementation')
  expect(main?.runs.map((r) => [r.phase, r.steps])).toEqual([
    ['analysis', 3],
    ['implementation', 1],
  ])
  expect(main?.wrote).toBe(true)
})

test('an agent whose type names a phase stays in it while it reads', () => {
  let s = spawned(emptyPhases(), { id: 'a1', type: 'zetetic-team-subagents:code-reviewer', description: 'review', model: 'claude-opus-5-5', at: 1 })
  s = stepped(s, step('a1', 'analysis'))
  s = finished(s, 'a1', 3)
  const a = s.loops.find((l) => l.id === 'a1')
  expect(a?.phase).toBe('review')
  expect(a?.status).toBe('done')
})

test('steps that come in before the spawn answers are kept on the row the spawn completes', () => {
  let s = stepped(emptyPhases(), step('a2', 'implementation'))
  s = stepped(s, step('a2', 'implementation'))
  s = spawned(s, { id: 'a2', type: 'zetetic-team-subagents:test-engineer', description: 'tests', model: 'claude-sonnet-5-5', at: 3 })
  const a = s.loops.find((l) => l.id === 'a2')
  expect(a?.type).toBe('zetetic-team-subagents:test-engineer')
  expect(a?.phase).toBe('test')
  expect(a?.runs).toEqual([{ phase: 'test', effort: 'medium', steps: 2, errors: 0, since: 2, reads: 0 }])
})

test('the advisor is counted with when it was called', () => {
  let s = startTurn(emptyPhases(), 't1', 'claude-opus-5-5', 1)
  s = stepped(s, step('main', 'analysis', 1))
  s = stepped(s, step('main', 'implementation'))
  s = stepped(s, step('main', 'report', 1))
  expect(s.advisor.session).toBe(2)
  expect(s.advisor.uses.map((u) => u.when)).toEqual(['before-write', 'at-completion'])
  expect(s.loops.find((l) => l.id === 'main')?.advisorCalls).toBe(2)
})

test('the list keeps its order and drops the oldest finished agents past the cap', () => {
  let s = startTurn(emptyPhases(), 't1', 'claude-opus-5-5', 1)
  for (let i = 0; i < LOOPS_CAP + 3; i++) {
    s = spawned(s, { id: `a${i}`, type: 'Explore', description: 'x', model: 'claude-haiku-5-5', at: i })
    s = finished(s, `a${i}`, i)
  }
  expect(s.loops.length).toBe(LOOPS_CAP)
  expect(s.loops[0]?.id).toBe('main')
  expect(s.loops[s.loops.length - 1]?.id).toBe(`a${LOOPS_CAP + 2}`)
})

test('a run is one phase at one effort; a failed call counts on the run it happened in', () => {
  let s = startTurn(emptyPhases(), 't1', 'claude-opus-5-5', 1)
  s = stepped(s, step('main', 'analysis'))
  s = erred(s, 'main')
  s = stepped(s, { ...step('main', 'analysis'), effort: 'low' })
  s = erred(s, 'nobody')
  expect(s.loops.find((l) => l.id === 'main')?.runs.map((r) => [r.phase, r.effort, r.steps, r.errors])).toEqual([
    ['analysis', 'medium', 1, 1],
    ['analysis', 'low', 1, 0],
  ])
})

test('a file-read step calls tools and every call is Read, Grep or Glob; a delegation or a recall is not', () => {
  expect(isFileReadStep([use('Read'), use('Grep')])).toBe(true)
  expect(isFileReadStep([use('Read'), use('Agent', { subagent_type: 'Explore' })])).toBe(false)
  expect(isFileReadStep([use('Agent', { subagent_type: 'Explore' })])).toBe(false)
  expect(isFileReadStep([use('mcp__plugin_hypermnesia-mcp_cortex__recall')])).toBe(false)
  expect(isFileReadStep([use('Bash', { command: 'ls' })])).toBe(false)
  expect(isFileReadStep([])).toBe(false)
})

test('reads counts the file-read steps of a run; an Agent(Explore) step is analysis but not a read', () => {
  const at = (uses: { name: string; input: unknown }[]) => ({ ...step('main', stepPhase(uses, '')), fileRead: isFileReadStep(uses) })
  let s = startTurn(emptyPhases(), 't1', 'claude-opus-5-5', 1)
  s = stepped(s, at([use('Read'), use('Grep')]))
  expect(s.loops[0]?.runs.map((r) => [r.phase, r.steps, r.reads])).toEqual([['analysis', 1, 1]])
  s = stepped(s, at([use('Read'), use('Agent', { subagent_type: 'Explore' })]))
  s = stepped(s, at([use('Agent', { subagent_type: 'Explore' })]))
  expect(s.loops[0]?.runs.map((r) => [r.phase, r.steps, r.reads])).toEqual([['analysis', 3, 1]])
})

test('merged keeps the sum of reads; a run recorded before reads existed stays unmeasured', () => {
  let s = stepped(emptyPhases(), { ...step('a3', 'analysis'), fileRead: true })
  s = stepped(s, { ...step('a3', 'analysis'), effort: 'low', fileRead: true })
  s = stepped(s, { ...step('a3', 'analysis'), effort: 'low' })
  s = spawned(s, { id: 'a3', type: 'Explore', description: 'x', model: 'claude-haiku-5-5', at: 3 })
  expect(s.loops.find((l) => l.id === 'a3')?.runs).toEqual([{ phase: 'analysis', effort: 'low', steps: 3, errors: 0, since: 2, reads: 2 }])
  const old = { ...s, loops: s.loops.map((l) => ({ ...l, id: 'a4', runs: [{ phase: 'analysis' as const, effort: 'low', steps: 5, errors: 0, since: 1 }] })) }
  const grown = stepped(old, { ...step('a4', 'analysis'), effort: 'low', fileRead: true })
  expect(grown.loops.find((l) => l.id === 'a4')?.runs[0]).toEqual({ phase: 'analysis', effort: 'low', steps: 6, errors: 0, since: 1 })
})

test('implementation work of the main loop: code and test files it writes, shell commands that change things', () => {
  expect(isMainImplementation('Edit', { file_path: '/r/src/a.ts' })).toBe(true)
  expect(isMainImplementation('Write', { file_path: '/r/src/a.test.ts' })).toBe(true)
  expect(isMainImplementation('Bash', { command: 'sed -i s/a/b/ src/a.ts' })).toBe(true)
})

test("the orchestrator's plumbing is not implementation work: fetch, worktree, hygiene, mkdir, gh", () => {
  for (const command of [
    'git fetch origin',
    'git worktree add -b fix/x /w/mods/.claude/worktrees/x origin/fix/x',
    'python3 /Users/cdeust/Developments/disk-hygiene/disk_hygiene.py --host claude register-worktree --repo /r --path /r/w',
    'mkdir -p /r/w && cd /r',
    'gh pr create --title t',
    'claude plugin validate .',
    'git -C /r merge-base a b',
  ])
    expect([command, isMainImplementation('Bash', { command })]).toEqual([command, false])
  // a change to a file, even behind plumbing in the same line, still counts
  expect(isMainImplementation('Bash', { command: 'git fetch && sed -i s/a/b/ src/a.ts' })).toBe(true)
})

test('orchestration is not implementation work: documents, reads, checks, tests, delivery, delegation', () => {
  expect(isMainImplementation('Write', { file_path: '/r/notes/plan.md' })).toBe(false)
  expect(isMainImplementation('Read', { file_path: '/r/a.ts' })).toBe(false)
  expect(isMainImplementation('Bash', { command: 'git status' })).toBe(false)
  expect(isMainImplementation('Bash', { command: 'claude plugin test' })).toBe(false)
  expect(isMainImplementation('Bash', { command: 'git commit -m x && git push' })).toBe(false)
  expect(isMainImplementation('Agent', { subagent_type: 'zetetic-team-subagents:engineer' })).toBe(false)
})

// Review of #25, m3: the nudge read only the first line and called every unknown head a change.
test("the repository's own gates and plain reads are not implementation work", () => {
  for (const command of [
    'node --test codex/tests/a.test.mjs',
    'node scripts/build-codex.mjs --check',
    'jq . a.json',
    'jq -r .version plugin.json > /dev/null',
    'python3 -c "print(1)"',
    `python3 -c "import json; print(json.load(open('a.json'))['version'])"`,
    'claude plugin test 2>&1 | tail -3',
    'git log > /tmp/log.txt',
    // a heredoc's body is data, whatever it says
    'cat <<EOF | gh pr comment 1 -F -\nrm -rf src\nEOF',
  ])
    expect([command, isMainImplementation('Bash', { command })]).toEqual([command, false])
})

test('commands that change the working tree are implementation work, on any line', () => {
  for (const command of [
    'git apply x.patch',
    'git checkout -- src/a.ts',
    'git checkout HEAD~1 -- src/a.ts',
    'git reset --hard origin/main',
    'git -C /r restore src/a.ts',
    'echo x > src/a.ts',
    'echo x >> src/a.ts',
    'cat > src/a.ts <<EOF\nexport const a = 1\nEOF',
    'true\nsed -i s/a/b/ src/a.ts',
    'cd /r\nnode scripts/build-codex.mjs',
    `python3 -c "open('src/a.ts', 'w').write('x')"`,
  ])
    expect([command, isMainImplementation('Bash', { command })]).toEqual([command, true])
})
