import { expect, test } from 'claude-code/testing'

import { isLiftCommand, isOrchestration, isReflectionCall, isSubagentTranscript, parseAllow } from './guard'

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

const LIFT = 'python3 /Users/x/.claude/plugins/reflection_ledger.py --cwd /Users/x/repo lift abc123 --memory-id 42'
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
  for (const c of [
    `${LIFT}; rm -rf /`,
    `${LIFT} && id`,
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
    ` ${LIFT}`,
    `${LIFT} `,
    undefined,
  ])
    expect(isLiftCommand(c)).toBe(false)
})

test('a reflection call is a Read of a transcript or a lift, by tool', () => {
  expect(isReflectionCall({ tool: 'Read', file_path: TRANSCRIPT })).toBe(true)
  expect(isReflectionCall({ tool: 'Bash', command: LIFT })).toBe(true)
  expect(isReflectionCall({ tool: 'Bash', file_path: TRANSCRIPT })).toBe(false)
  expect(isReflectionCall({ tool: 'Read', command: LIFT })).toBe(false)
  expect(isReflectionCall({ tool: 'Write', file_path: TRANSCRIPT })).toBe(false)
  expect(isReflectionCall({ tool: 'Grep', file_path: TRANSCRIPT })).toBe(false)
})
