import { expect, test } from 'claude-code/testing'

import {
  GREP_MAX, isGrepCommand, isLiftCommand, isListCommand, isOrchestration, isReflectionCall, isSubagentTranscript,
  isTranscriptOnDisk, parseAllow, projectsDir, shellWords,
} from './guard'

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
const HOME = '/Users/x'
const TRANSCRIPT = '/Users/x/.claude/projects/-Users-x-repo/s1/subagents/agent-a1.jsonl'

test('the transcript of a subagent may be read, nothing else', () => {
  expect(isSubagentTranscript(TRANSCRIPT, HOME)).toBe(true)
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
    expect(isSubagentTranscript(p, HOME)).toBe(false)
})

test('only the ledger lift may be run, as one plain command', () => {
  expect(isLiftCommand(LIFT)).toBe(true)
  expect(isLiftCommand(REAL)).toBe(true)
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

test('a reflection call is a Read of a transcript or a lift, by tool', () => {
  expect(isReflectionCall({ tool: 'Read', file_path: TRANSCRIPT }, HOME)).toBe(true)
  expect(isReflectionCall({ tool: 'Bash', command: LIFT }, HOME)).toBe(true)
  expect(isReflectionCall({ tool: 'Bash', file_path: TRANSCRIPT }, HOME)).toBe(false)
  expect(isReflectionCall({ tool: 'Read', command: LIFT }, HOME)).toBe(false)
  expect(isReflectionCall({ tool: 'Write', file_path: TRANSCRIPT }, HOME)).toBe(false)
  expect(isReflectionCall({ tool: 'Grep', file_path: TRANSCRIPT }, HOME)).toBe(false)
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
  expect(isReflectionCall({ tool: 'Bash', command: LIST }, HOME)).toBe(true)
})

test('one read-only grep over subagent transcripts may be run', () => {
  const T2 = '/Users/x/.claude/projects/-Users-x-repo/s1/subagents/agent-b2.jsonl'
  for (const c of [
    `grep -c tool_use ${TRANSCRIPT}`,
    `grep -m 3 -o -E tool_use ${TRANSCRIPT}`,
    `grep -ci tool_use ${TRANSCRIPT} ${T2}`,
    `grep -n -m 5 -e tool_use ${TRANSCRIPT}`,
    `grep -m 1 -A 2 -B 1 -C 0 error ${TRANSCRIPT}`,
    `grep -c -F -e a.b ${TRANSCRIPT}`,
    `grep -c .. ${TRANSCRIPT}`,
  ])
    expect(isGrepCommand(c, HOME)).toBe(true)
  expect(isReflectionCall({ tool: 'Bash', command: `grep -c tool_use ${TRANSCRIPT}` }, HOME)).toBe(true)
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
    `grep -c -r tool_use /Users/x/.claude/projects/-Users-x-repo/s1/subagents`,
    `grep -rc tool_use ${TRANSCRIPT}`,
    `grep -c -f /etc/passwd ${TRANSCRIPT}`,
    `grep -c -m x tool_use ${TRANSCRIPT}`,
    `grep -c -- tool_use ${TRANSCRIPT}`,
    `grep -c --include=x tool_use ${TRANSCRIPT}`,
    `grep -c tool_use ${TRANSCRIPT} -r`,
    `grep -c -e -v ${TRANSCRIPT}`,
    `egrep -c tool_use ${TRANSCRIPT}`,
    `cat ${TRANSCRIPT}`,
    ` grep -c tool_use ${TRANSCRIPT}`,
    undefined,
  ])
    expect(isGrepCommand(c, HOME)).toBe(false)
})

// The tokenizer: the words the guard checks are the argv zsh and bash build (they split on space, tab and newline
// only; checked over every character 0x01 to 0x7f and the Unicode spaces), so any other form is refused.
test('the guard reads a command as the shell does, or not at all', () => {
  expect(shellWords(`grep -c tool_use ${TRANSCRIPT}`)).toEqual(['grep', '-c', 'tool_use', TRANSCRIPT])
  const spaces = [
    '\t', '\n', '\v', '\f', '\r', '\u0085', ' ', ' ', ' ', ' ', ' ', ' ', ' ',
    ' ', ' ', ' ', ' ', ' ', ' ', '​', ' ', ' ', ' ', ' ',
    '　', '﻿', '\u0000', '\u001b', '\u007f',
  ]
  for (const s of spaces) {
    expect(shellWords(`grep -c x${s}${TRANSCRIPT}`)).toBeUndefined()
    expect(shellWords(`grep${s}-c x ${TRANSCRIPT}`)).toBeUndefined()
    expect(shellWords(`grep -c x ${TRANSCRIPT}${s}`)).toBeUndefined()
    expect(shellWords(`${s}grep -c x ${TRANSCRIPT}`)).toBeUndefined()
  }
  for (const c of ['grep  -c x y', ' grep -c x y', 'grep -c x y ', 'grep -c ^x y', 'grep -c é y', 'grep -c x;id y', ''])
    expect(shellWords(c)).toBeUndefined()
  expect(shellWords(undefined)).toBeUndefined()
})

test('a transcript belongs to this HOME, and HOME is canonical', () => {
  expect(isSubagentTranscript(TRANSCRIPT, HOME)).toBe(true)
  expect(isSubagentTranscript(TRANSCRIPT, '/Users/y')).toBe(false)
  for (const home of [undefined, '', '/', '/Users/x/', 'Users/x', '/Users//x', '/Users/./x', '/Users/x/..', 42])
    expect(isSubagentTranscript(TRANSCRIPT, home)).toBe(false)
  for (const p of [
    `/${TRANSCRIPT}`,
    TRANSCRIPT.replace('/s1/', '/./s1/'),
    TRANSCRIPT.replace('/s1/', '//s1/'),
    TRANSCRIPT.replace('agent-a1', '.agent-a1'),
    TRANSCRIPT.replace('agent-a1', 'agent\ta1'),
    '/tmp/evil/.claude/projects/-Users-x-repo/s1/subagents/agent-a1.jsonl',
    `${TRANSCRIPT}/`,
  ])
    expect(isSubagentTranscript(p, HOME)).toBe(false)
})

test('on disk, a transcript is a regular file where its path says', () => {
  const projects = { kind: 'dir', isLink: false, realPath: projectsDir(HOME) }
  const file = { kind: 'file', isLink: false, realPath: TRANSCRIPT }
  expect(isTranscriptOnDisk(file, projects, TRANSCRIPT, HOME)).toBe(true)
  // the owner's ~/.claude may itself be a link: what counts is the place under the real projects folder
  const moved = { kind: 'dir', isLink: false, realPath: '/Volumes/d/claude/projects' }
  expect(isTranscriptOnDisk({ ...file, realPath: '/Volumes/d/claude/projects/-Users-x-repo/s1/subagents/agent-a1.jsonl' }, moved, TRANSCRIPT, HOME)).toBe(true)
  expect(isTranscriptOnDisk({ ...file, kind: 'dir' }, projects, TRANSCRIPT, HOME)).toBe(false) // a directory
  expect(isTranscriptOnDisk({ ...file, kind: 'other' }, projects, TRANSCRIPT, HOME)).toBe(false) // a dangling link, a fifo
  expect(isTranscriptOnDisk({ ...file, isLink: true }, projects, TRANSCRIPT, HOME)).toBe(false) // a link, even to itself
  expect(isTranscriptOnDisk({ ...file, realPath: '/tmp/s/secret.txt' }, projects, TRANSCRIPT, HOME)).toBe(false) // a linked folder
  expect(isTranscriptOnDisk({ kind: 'file', isLink: false }, projects, TRANSCRIPT, HOME)).toBe(false) // not resolved
  expect(isTranscriptOnDisk(file, { kind: 'dir', isLink: false }, TRANSCRIPT, HOME)).toBe(false)
  expect(isTranscriptOnDisk(file, { ...projects, kind: 'file' }, TRANSCRIPT, HOME)).toBe(false)
  expect(isTranscriptOnDisk(file, projects, '/tmp/s/secret.txt', HOME)).toBe(false)
})

test('a grep is bounded: -m or -c, small context, few files', () => {
  expect(GREP_MAX).toEqual({ lines: 10, context: 2, files: 5 })
  const files = (n: number): string => Array.from({ length: n }, () => TRANSCRIPT).join(' ')
  expect(isGrepCommand(`grep -c x ${files(5)}`, HOME)).toBe(true)
  expect(isGrepCommand(`grep -c x ${files(6)}`, HOME)).toBe(false)
  expect(isGrepCommand(`grep -m 10 -C 2 x ${TRANSCRIPT}`, HOME)).toBe(true)
  for (const c of [
    `grep x ${TRANSCRIPT}`,
    `grep -o . ${TRANSCRIPT}`,
    `grep -m 11 x ${TRANSCRIPT}`,
    `grep -m 0 x ${TRANSCRIPT}`,
    `grep -m 100 x ${TRANSCRIPT}`,
    `grep -m 1 -C 3 x ${TRANSCRIPT}`,
    `grep -m 1 -A 99999999 x ${TRANSCRIPT}`,
    `grep -C 99999999 x ${TRANSCRIPT}`,
  ])
    expect(isGrepCommand(c, HOME)).toBe(false)
})
