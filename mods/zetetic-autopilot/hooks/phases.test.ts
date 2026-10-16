import { expect, test } from 'claude-code/testing'

import { LOOPS_CAP, emptyPhases, erred, finished, isFileReadStep, spawned, startTurn, stepPhase, stepped, toolPhase, typePhase } from './phases'

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

test('an agent whose type names a phase is in the phase a step did when the step does more than read', () => {
  let s = spawned(emptyPhases(), { id: 'e1', type: 'zetetic-team-subagents:engineer', description: 'fix', model: 'claude-sonnet-5-5', at: 1 })
  s = stepped(s, step('e1', 'analysis'))
  s = stepped(s, step('e1', 'test'))
  s = stepped(s, step('e1', undefined))
  // The spawn's own run (no step yet, no effort) comes first.
  expect(s.loops.find((l) => l.id === 'e1')?.runs.map((r) => [r.phase, r.steps])).toEqual([['implementation', 0], ['implementation', 1], ['test', 1], ['implementation', 1]])
})

test('a test run is recognised whatever names its interpreter, and data never names a command', () => {
  const phase = (command: string) => toolPhase('Bash', { command })
  // source: misses replayed from the transcripts, docs/verification/phase-attribution-2026-10-16.md
  expect(phase('.venv/bin/python -m pytest -q -p no:cacheprovider tests_py/hooks 2>&1 | tail -30')).toBe('test')
  expect(phase('cd /r/Cortex && /usr/bin/time -p .venv/bin/python -m pytest -q > /tmp/l.log 2>&1')).toBe('test')
  expect(phase('L=/tmp/x.log; nohup .venv/bin/python -m pytest -q > $L 2>&1 &')).toBe('test')
  expect(phase('for d in a b; do r=$(.venv/bin/python -m pytest -q -x "$d"); done')).toBe('test')
  expect(phase("bash -c 'cd mods/x && claude plugin test'")).toBe('test')
  expect(phase('node --test codex/tests/*.test.mjs')).toBe('test')
  expect(phase('uv run pytest -q')).toBe('test')
  expect(phase('timeout 600 npx vitest run')).toBe('test')
  expect(phase('grep -n "toolPhase\\|test" a.ts | head')).toBe('analysis')
  expect(phase('ps -o pid,command -p 1 | cut -c1-80')).toBe('analysis')
  expect(phase("sed -i '' 's/a/b/' src/a.py")).toBe('implementation')
  expect(phase('grep -c x a.txt > counts.txt')).toBe('implementation')
  expect(phase('ls 2>/dev/null')).toBe('analysis')
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
