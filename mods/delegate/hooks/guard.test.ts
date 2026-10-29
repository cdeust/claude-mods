import { expect, test } from 'claude-code/testing'

import { isGrepCommand, isLiftCommand, isListCommand, isOrchestration, isReflectionCall, isSubagentTranscript, parseAllow } from './guard'

test('orchestration tools stay, work tools go', () => {
  for (const t of ['Agent', 'SendMessage', 'AskUserQuestion', 'Skill', 'ToolSearch']) expect(isOrchestration(t)).toBe(true)
  for (const t of ['Bash', 'Edit', 'Write', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']) expect(isOrchestration(t)).toBe(false)
})

test('the memory servers stay', () => {
  expect(isOrchestration('mcp__plugin_hypermnesia-mcp_cortex__recall')).toBe(true)
  expect(isOrchestration('mcp__crawl4ai__scrape')).toBe(false)
})

test('the extra list matches a name or a prefix', () => {
  const extra = parseAllow(' Read, mcp__my__* ,')
  expect(extra).toEqual(['Read', 'mcp__my__*'])
  expect(isOrchestration('Read', extra)).toBe(true)
  expect(isOrchestration('mcp__my__x', extra)).toBe(true)
  expect(isOrchestration('Edit', extra)).toBe(false)
})

const SCRIPT = '/Users/x/.claude/plugins/cache/m/p/1.0.0/tools/reflection_ledger.py'
const LIFT = `python3 ${SCRIPT} --cwd /Users/x/repo lift abc123 --memory-id 42`
const REAL =
  'python3 /Users/cdeust/.claude/plugins/cache/zetetic-marketplace/zetetic-team-subagents/2.45.1/tools/reflection_ledger.py --cwd /Users/cdeust/Developments/anthropic-partnership/claude-mods lift ab52aa3ac5e98f4f1 --memory-id 4407125'
const TRANSCRIPT = '/Users/x/.claude/projects/-Users-x-repo/s1/subagents/agent-a1.jsonl'

test('the transcript of a subagent may be read, nothing else', () => {
  expect(isSubagentTranscript(TRANSCRIPT)).toBe(true)
  for (const p of [
    '/Users/x/.claude/projects/-Users-x-repo/s1.jsonl', // the main transcript, not a subagent's
    '/Users/x/.claude/projects/-Users-x-repo/s1/subagents/agent-a1.json',
    '/Users/x/notes.txt',
    '/Users/x/repo/subagents/a.jsonl',
    '/Users/x/subagents/.claude/projects/a.jsonl', // the order matters
    '.claude/projects/x/subagents/a.jsonl', // not absolute
    '~/.claude/projects/x/subagents/a.jsonl',
    '/Users/x/.claude/projects/x/subagents/../../../../notes/a.jsonl', // a `..` segment
    '/Users/x/.claude/projects/x/subagents/a.jsonl\0.txt',
    undefined,
    42,
  ])
    expect(isSubagentTranscript(p)).toBe(false)
})

test('only the ledger lift may be run, as one plain command', () => {
  expect(isLiftCommand(LIFT)).toBe(true)
  expect(isLiftCommand(REAL)).toBe(true)
  for (const c of [
    `${LIFT}; rm -rf /`,
    `${LIFT} && id`,
    `${LIFT}; rm -rf x`,
    `${LIFT} | sh`,
    `${LIFT};`,
    `${LIFT};;${LIFT}`,
    `${LIFT} &&& ${LIFT}`,
    `${LIFT} & ${LIFT}`,
    `${LIFT}\n${LIFT}`,
    `${LIFT}; ls`,
    `PATH=/tmp; ${LIFT}`,
    `ID=$(id); ${LIFT}`,
    `ID=\`id\`; ${LIFT}`,
    `A_ID=1 ${LIFT}`,
    `${LIFT}; ${LIFT} > /tmp/x`,
    `${LIFT}; ${LIFT} | sh`,
    `${LIFT}; ${LIFT} ; rm x`,
    'ID=1',
    `${LIFT} | sh`,
    `${LIFT} & id`,
    `${LIFT}\nid`,
    `${LIFT}\r`,
    `${LIFT} $(id)`,
    `${LIFT} \`id\``,
    `${LIFT} > /tmp/x`,
    `${LIFT} < /tmp/x`,
    `echo x; ${LIFT}`,
    `(${LIFT})`,
    LIFT.replace('/Users/x/repo', '$HOME'),
    LIFT.replace('/Users/x/repo', '"/Users/x/repo"'),
    LIFT.replace('/Users/x/repo', '/Users/x/{a,b}'),
    LIFT.replace('/Users/x/repo', '/Users/x/*'),
    LIFT.replace('abc123', 'ABC'),
    LIFT.replace('42', '4x'),
    LIFT.replace('lift', 'drop'),
    LIFT.replace('python3', 'python3 -c'),
    LIFT.replace('reflection_ledger.py', 'other.py'),
    LIFT.replace(SCRIPT, '/tmp/x/reflection_ledger.py'), // outside the home directory
    LIFT.replace(SCRIPT, '/tmp/x/.claude/plugins/cache/m/p/1.0.0/tools/reflection_ledger.py'),
    LIFT.replace(SCRIPT, '/Users/x/.claude/plugins/cache/../../../evil/tools/reflection_ledger.py'), // a `..` segment
    LIFT.replace(SCRIPT, '/Users/x/.claude/plugins/cache/m/../../../tools/reflection_ledger.py'),
    LIFT.replace(SCRIPT, '/Users/x/.claude/plugins/reflection_ledger.py'), // not under cache, not in tools/
    LIFT.replace(SCRIPT, '/Users/x/.claude/plugins/cache/m/p/1.0.0/reflection_ledger.py'), // not in tools/
    LIFT.replace(SCRIPT, '/Users/x/repo/tools/reflection_ledger.py'), // outside .claude/plugins/cache
    LIFT.replace(SCRIPT, 'Users/x/.claude/plugins/cache/m/p/tools/reflection_ledger.py'), // relative
    LIFT.replace('--cwd /Users/x/repo', '--cwd ..'),
    LIFT.replace('--cwd /Users/x/repo', '--cwd /Users/x/../..'),
    LIFT.replace('--cwd /Users/x/repo', '--cwd repo'), // relative
    ` ${LIFT}`,
    `${LIFT} `,
    undefined,
  ])
    expect(isLiftCommand(c)).toBe(false)
})

test('lifts chained by && are one command, nothing else', () => {
  const other = LIFT.replace('abc123', 'def456').replace('42', '43')
  for (const c of [`${LIFT} && ${other}`, `${LIFT}&&${other}`, `${LIFT} && ${other} && ${REAL}`]) {
    expect(isLiftCommand(c)).toBe(true)
    expect(isReflectionCall({ tool: 'Bash', command: c })).toBe(true)
  }
})

// F2 (review of #57): after `;` the exit status is the last segment's, so a refused first lift would be reported as
// done. `&&` stops at the first failure and reports it, so it is the only separator.
test('a chain separated by ; is refused: it would hide the failure of an earlier lift', () => {
  const other = LIFT.replace('abc123', 'def456').replace('42', '43')
  for (const c of [`${LIFT}; ${other}`, `${LIFT};${other}`, `${LIFT}; ${other}; ${REAL}`, `${LIFT} && ${other}; ${REAL}`])
    expect(isLiftCommand(c)).toBe(false)
})

// F1 (review of #57): an assignment of a name that is already exported reaches the child process (`CLAUDE_PID=1; ...`
// changed what python3 and git received), zsh acts on some names (`UID=0` calls setuid, `X_id==ls` expands `=ls`),
// and nothing can read a variable that `$` stays refused for. No assignment is a segment.
test('no segment is an assignment, whatever the name', () => {
  for (const a of [
    'CLAUDE_PID=1',
    'CLAUDE_CODE_SESSION_ID=forged',
    'AGENT_ID=abc123',
    'agentId=abc123',
    'SECURITYSESSIONID=forged',
    'SUDO_UID=0',
    'UID=0',
    'EUID=0',
    'GID=0',
    'EGID=0',
    'PPID=1',
    'X_id==ls',
    'ID=1',
  ])
    for (const c of [`${a} && ${LIFT}`, `${LIFT} && ${a}`, `${a}&&${LIFT}`, `${a}; ${LIFT}`, `${a} ${LIFT}`]) {
      expect(isLiftCommand(c)).toBe(false)
      expect(isReflectionCall({ tool: 'Bash', command: c })).toBe(false)
    }
})

// F3 and F4 (review of #57): at most one space on each side of `&&`, and no NUL anywhere in the command.
test('two spaces around && and a NUL byte are refused', () => {
  const other = LIFT.replace('abc123', 'def456').replace('42', '43')
  expect(isLiftCommand(`${LIFT}  &&  ${other}`)).toBe(false)
  expect(isLiftCommand(`${LIFT} &&  ${other}`)).toBe(false)
  expect(isLiftCommand(`${LIFT}  && ${other}`)).toBe(false)
  expect(isLiftCommand(`${LIFT.replace('--cwd /Users/x/repo', '--cwd /Users/x/re\u0000po')}`)).toBe(false)
  expect(isLiftCommand(`${LIFT} && ${other.replace('def456', 'def\u0000456')}`)).toBe(false)
  expect(isListCommand(`python3 /Users/x/.claude/plugins/cache/m/p/1.0.0/tools/reflection_ledger.py --cwd /Users/x/re\u0000po list`)).toBe(false)
  expect(isGrepCommand(`grep tool_use ${TRANSCRIPT}\u0000`)).toBe(false)
})

test('a reflection call is a lift and nothing else', () => {
  expect(isReflectionCall({ tool: 'Bash', command: `${LIFT}; rm -rf x` })).toBe(false)
  expect(isReflectionCall({ tool: 'Bash', command: `${LIFT} | sh` })).toBe(false)
  expect(isReflectionCall({ tool: 'Bash', command: 'ls' })).toBe(false)
  expect(isReflectionCall({ tool: 'Write', command: LIFT })).toBe(false)
})

test('a reflection call is a Read of a transcript or a lift, by tool', () => {
  expect(isReflectionCall({ tool: 'Read', file_path: TRANSCRIPT })).toBe(true)
  expect(isReflectionCall({ tool: 'Bash', command: LIFT })).toBe(true)
  expect(isReflectionCall({ tool: 'Bash', file_path: TRANSCRIPT })).toBe(false)
  expect(isReflectionCall({ tool: 'Read', command: LIFT })).toBe(false)
  expect(isReflectionCall({ tool: 'Write', file_path: TRANSCRIPT })).toBe(false)
  expect(isReflectionCall({ tool: 'Grep', file_path: TRANSCRIPT })).toBe(false)
})

const LIST = `python3 ${SCRIPT} --cwd /Users/x/repo list`

test('the ledger list may be run, as one plain command', () => {
  expect(isListCommand(LIST)).toBe(true)
  for (const c of [
    `${LIST}; id`, `${LIST} | sh`, `${LIST} > /tmp/x`, `${LIST} extra`, `${LIST}\nid`, `${LIST} $(id)`,
    LIST.replace('list', 'lift abc --memory-id 1'),
    LIST.replace('--cwd /Users/x/repo', '--cwd ..'),
    LIST.replace('--cwd /Users/x/repo', '--cwd /Users/x/../..'),
    LIST.replace(SCRIPT, '/tmp/x/reflection_ledger.py'),
    LIST.replace(SCRIPT, '/Users/x/.claude/plugins/cache/../../evil/tools/reflection_ledger.py'),
    `python3 -c ${LIST.slice(8)}`,
    undefined,
  ])
    expect(isListCommand(c)).toBe(false)
  expect(isReflectionCall({ tool: 'Bash', command: LIST })).toBe(true)
})

test('one read-only grep over subagent transcripts may be run', () => {
  const T2 = '/Users/x/.claude/projects/-Users-x-repo/s1/subagents/agent-b2.jsonl'
  for (const c of [
    `grep -c tool_use ${TRANSCRIPT}`,
    `grep -o -E tool_use ${TRANSCRIPT}`,
    `grep -ci tool_use ${TRANSCRIPT} ${T2}`,
    `grep -n -m 5 -e tool_use ${TRANSCRIPT}`,
    `grep -A 2 -B 3 -C 4 error ${TRANSCRIPT}`,
    `grep -F -e a.b ${TRANSCRIPT}`,
  ])
    expect(isGrepCommand(c)).toBe(true)
  expect(isReflectionCall({ tool: 'Bash', command: `grep -c tool_use ${TRANSCRIPT}` })).toBe(true)
  for (const c of [
    `grep -c tool_use ${TRANSCRIPT} | head`,
    `grep -c tool_use ${TRANSCRIPT}; id`,
    `grep -c tool_use ${TRANSCRIPT} && id`,
    `grep -c tool_use ${TRANSCRIPT} > /tmp/x`,
    `grep -c tool_use < ${TRANSCRIPT}`,
    `grep -c $(id) ${TRANSCRIPT}`,
    `grep -c \`id\` ${TRANSCRIPT}`,
    `grep -c "tool use" ${TRANSCRIPT}`,
    `grep -c 'a' ${TRANSCRIPT}`,
    `grep -c tool_use ${TRANSCRIPT}\nid`,
    `grep -c tool_use /Users/x/.claude/projects/*/s1/subagents/*.jsonl`,
    `grep -c tool_use /Users/x/.claude/projects/-Users-x-repo/s1/subagents/../../../../notes/a.jsonl`,
    `grep -c tool_use /Users/x/notes.txt`,
    `grep -c tool_use /Users/x/.claude/projects/-Users-x-repo/s1.jsonl`,
    `grep -c tool_use ${TRANSCRIPT} /etc/passwd`,
    `grep -c tool_use`,
    `grep -c ${TRANSCRIPT}`,
    `grep -r tool_use /Users/x/.claude/projects/-Users-x-repo/s1/subagents`,
    `grep -rc tool_use ${TRANSCRIPT}`,
    `grep -f /etc/passwd ${TRANSCRIPT}`,
    `grep -c -m x tool_use ${TRANSCRIPT}`,
    `grep -c -- tool_use ${TRANSCRIPT}`,
    `grep --include=x tool_use ${TRANSCRIPT}`,
    `grep -c tool_use ${TRANSCRIPT} -r`,
    `grep -e -v ${TRANSCRIPT}`,
    `egrep tool_use ${TRANSCRIPT}`,
    `cat ${TRANSCRIPT}`,
    ` grep -c tool_use ${TRANSCRIPT}`,
    undefined,
  ])
    expect(isGrepCommand(c)).toBe(false)
})
