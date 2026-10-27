import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

test('the main loop is refused a work tool, a subagent is not', async ($, on) => {
  on('tool.call', () => ({ result: {} }))

  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toMatch(/delegate/)
  expect((await $.tool.call({ tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b' })).deny).toMatch(/delegate/)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })).deny).toBeUndefined()
})

test('warn mode lets the main loop through', { options: { main_mode: 'warn' } }, async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
})

test('off mode touches nothing', { options: { main_mode: 'off' } }, async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
})

test('an Agent call without model or effort is routed, a named one is kept', async ($, on) => {
  const seen: Array<{ model?: string; effort?: string }> = []
  on('tool.call', (_, e) => {
    if (e.tool === 'Agent') seen.push({ model: e.model, effort: e.effort })
    return { result: {} }
  })

  await $.tool.call({ tool: 'Agent', description: 'Crawl the docs', prompt: 'p' })
  await $.tool.call({ tool: 'Agent', description: 'Crawl the docs', prompt: 'p', model: 'opus', effort: 'max' })
  await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'p', subagent_type: 'fork' })

  expect(seen[0]).toEqual({ model: 'haiku', effort: 'low' })
  expect(seen[1]).toEqual({ model: 'opus', effort: 'max' })
  expect(seen[2]).toEqual({ model: undefined, effort: undefined })
})

const HOME = '/Users/x'
const PROJECTS = `${HOME}/.claude/projects`
const TRANSCRIPT = `${PROJECTS}/-Users-x-repo/s1/subagents/agent-a1.jsonl`
const T2 = `${PROJECTS}/-Users-x-repo/s1/subagents/agent-b2.jsonl`
const SCRIPT = `${HOME}/.claude/plugins/cache/m/p/1.0.0/tools/reflection_ledger.py`
const LIFT = `python3 ${SCRIPT} --cwd /Users/x/repo lift abc123 --memory-id 42`
const LIST = `python3 ${SCRIPT} --cwd /Users/x/repo list`
// The scratch folder of the review's probes (docs/verification/pr50-review-round1-2026-10-27.md), as a path only.
const S = '/tmp/s'

// The disk as the engine's fs.stat answers it (FsStat): a regular file, a directory named *.jsonl, a link named
// *.jsonl to a secret, a transcript under a `subagents` folder that is itself a link, and the projects folder.
// A path not listed is missing (ENOENT). The test kit has no file system, so the disk is answered here.
type Stat = { kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean; realPath?: string }
const file = (realPath: string): Stat => ({ kind: 'file', size: 1, mtimeMs: 0, isLink: false, realPath })
const DIR_JSONL = `${PROJECTS}/-Users-x-repo/s1/subagents/d.jsonl`
const LINK_JSONL = `${PROJECTS}/-Users-x-repo/s1/subagents/link.jsonl`
const UNDER_LINKED_DIR = `${PROJECTS}/-Users-x-repo/s2/subagents/agent-c3.jsonl`
const MISSING = `${PROJECTS}/-Users-x-repo/s1/subagents/agent-gone.jsonl`
const DISK: Record<string, Stat> = {
  [PROJECTS]: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: PROJECTS },
  [TRANSCRIPT]: file(TRANSCRIPT),
  [T2]: file(T2),
  [DIR_JSONL]: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: DIR_JSONL },
  [LINK_JSONL]: { kind: 'file', size: 1, mtimeMs: 0, isLink: true, realPath: `${S}/secret.txt` },
  [UNDER_LINKED_DIR]: file(`${S}/elsewhere/agent-c3.jsonl`),
}
function disk(on: On, home: Record<string, string> = { HOME }): void {
  mock.env(on, home)
  on('fs.stat', (_, e) => {
    // The kit resolves a path against the platform (D:\Users\x on Windows); the disk here is keyed by POSIX path.
    const stat = DISK[e.path.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/')]
    if (stat === undefined) throw new Error(`ENOENT: no such file or directory, stat '${e.path}'`)
    return { value: stat }
  })
}

test('block: the main loop may read a subagent transcript and run one lift, no more', async ($, on) => {
  disk(on)
  on('tool.call', () => ({ result: {} }))
  expect((await $.tool.call({ tool: 'Read', file_path: TRANSCRIPT })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: LIFT })).deny).toBeUndefined()

  // another path, a path that climbs out, a chained command, a lift with a tail
  expect((await $.tool.call({ tool: 'Read', file_path: '/Users/x/notes.txt' })).deny).toMatch(/delegate/)
  expect((await $.tool.call({ tool: 'Read', file_path: '/Users/x/.claude/projects/x/subagents/../../../../notes/a.jsonl' })).deny).toMatch(/delegate/)
  expect((await $.tool.call({ tool: 'Bash', command: `${LIFT}; id` })).deny).toMatch(/delegate/)
  expect((await $.tool.call({ tool: 'Bash', command: `${LIFT} && cat /etc/hosts` })).deny).toMatch(/delegate/)
  expect((await $.tool.call({ tool: 'Bash', command: `${LIFT}\nid` })).deny).toMatch(/delegate/)
  expect((await $.tool.call({ tool: 'Write', file_path: TRANSCRIPT, content: 'x' })).deny).toMatch(/delegate/)
})

test('block: a read-only grep of a transcript and the ledger list pass, other Bash is refused', async ($, on) => {
  disk(on)
  on('tool.call', () => ({ result: {} }))
  expect((await $.tool.call({ tool: 'Bash', command: `grep -c tool_use ${TRANSCRIPT}` })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: LIST })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: `grep -c tool_use ${TRANSCRIPT} | sh` })).deny).toMatch(/delegate/)
  expect((await $.tool.call({ tool: 'Bash', command: 'grep -c tool_use /etc/hosts' })).deny).toMatch(/delegate/)
  expect((await $.tool.call({ tool: 'Bash', command: `${LIST}; id` })).deny).toMatch(/delegate/)
})

// The calls of `calls` the guard let through (no deny), or refused, so a failure lists every one of them.
type Gate = (call: object) => Promise<{ deny?: string }>
async function through(gate: Gate, calls: object[]): Promise<string[]> {
  const out: string[] = []
  for (const call of calls) if ((await gate(call)).deny === undefined) out.push(JSON.stringify(call))
  return out
}
async function refused(gate: Gate, calls: object[]): Promise<string[]> {
  const out: string[] = []
  for (const call of calls) if ((await gate(call)).deny !== undefined) out.push(JSON.stringify(call))
  return out
}
const bash = (command: string): object => ({ tool: 'Bash', command })
const read = (file_path: string): object => ({ tool: 'Read', file_path })

test('block: a grep within the bounds passes, the pattern `..` included', async ($, on) => {
  disk(on)
  on('tool.call', () => ({ result: {} }))
  const gate: Gate = (c) => $.tool.call(c as never)
  expect(await refused(gate, [
    `grep -c .. ${TRANSCRIPT}`, // L1: the dot-dot rule is for paths, not the pattern
    `grep -c -e .. ${TRANSCRIPT}`,
    `grep -m 10 -o tool_use ${TRANSCRIPT}`,
    `grep -n -m 3 -A 2 -B 2 -C 2 error ${TRANSCRIPT} ${T2}`,
    `grep -ci tool_use ${TRANSCRIPT} ${T2}`,
  ].map(bash))).toEqual([])
})

// Every input of the review's probes and of its /code-review findings, through the hook in block mode.
test('block: the PR 50 review probes are refused (H1, whitespace that splits shell words)', async ($, on) => {
  disk(on)
  on('tool.call', () => ({ result: {} }))
  const gate: Gate = (c) => $.tool.call(c as never)
  expect(await through(gate, [
    `grep -h TOPSECRET ${S}/secret.txt\t${TRANSCRIPT}`,
    `grep -c TOPSECRET ${S}/secret.txt\t${TRANSCRIPT}`,
    `grep -h TOPSECRET ${S}/other\t-r\t${TRANSCRIPT}`,
    `grep -c x /x\t-f\t/etc/passwd\t${TRANSCRIPT}`,
    `grep -c x /x\t--filter=sh\t${TRANSCRIPT}`,
    `grep -c x /etc/passwd\v${TRANSCRIPT}`,
    `grep -c x /etc/passwd ${TRANSCRIPT}`,
    `grep -c x /foo\t..\t${TRANSCRIPT}`,
    `grep -c x ${PROJECTS}/-Users-x-repo/s1/subagents/q\t../../../etc/x.jsonl`,
    `grep -c root /etc/passwd\t${TRANSCRIPT}`,
    `grep -c x /a\t-r\t/etc\t${TRANSCRIPT}`,
    `grep -c x a\t..\t${TRANSCRIPT}`,
    LIST.replace(' list', '\tlist'),
  ].map(bash))).toEqual([])
})

test('block: every whitespace other than one space is refused, wherever it stands', async ($, on) => {
  disk(on)
  on('tool.call', () => ({ result: {} }))
  const gate: Gate = (c) => $.tool.call(c as never)
  const spaces = [
    '\t', '\n', '\v', '\f', '\r', '\u0085', ' ', ' ', ' ', ' ', ' ', ' ', ' ',
    '​', ' ', ' ', ' ', ' ', '　', '﻿', '  ',
  ]
  const words = ['grep', '-c', 'tool_use', TRANSCRIPT]
  const commands: string[] = []
  for (const s of spaces) {
    for (let at = 1; at < words.length; at++) commands.push([words.slice(0, at).join(' '), words.slice(at).join(' ')].join(s))
    // inside a file operand that ends as a transcript: the H1 position
    commands.push(`grep -c tool_use /etc/passwd${s}${TRANSCRIPT}`, `grep -c tool_use ${S}/secret.txt${s}${TRANSCRIPT}`)
    commands.push(`${s}grep -c tool_use ${TRANSCRIPT}`, `grep -c tool_use ${TRANSCRIPT}${s}`, `${LIFT}${s}`)
  }
  expect(await through(gate, commands.map(bash))).toEqual([])
})

test('block: a transcript is under the real HOME, canonical, and a regular file on disk (M1)', async ($, on) => {
  disk(on)
  on('tool.call', () => ({ result: {} }))
  const gate: Gate = (c) => $.tool.call(c as never)
  const paths = [
    '/tmp/evil/.claude/projects/a/subagents/b.jsonl', // the review's probe
    '/tmp/evil/.claude/projects/p/s1/subagents/b.jsonl', // the right layout, not under HOME
    '/Users/y/.claude/projects/p/s1/subagents/a.jsonl', // another home
    `/${TRANSCRIPT}`, // a leading double slash
    TRANSCRIPT.replace('/.claude', '//.claude'),
    TRANSCRIPT.replace('/subagents/', '//subagents/'),
    '/Users/x/.claude/projects/./subagents/b.jsonl', // the review's probe
    TRANSCRIPT.replace('/s1/', '/./s1/'),
    TRANSCRIPT.replace('/.claude', '/./.claude'),
    `${PROJECTS}/-Users-x-repo/s1/subagents/.hidden.jsonl`,
    `${PROJECTS}/-Users-x-repo/s1/subagents/x/agent-a1.jsonl`, // one level too deep
    `${DIR_JSONL}/`, // a trailing slash
    DIR_JSONL, // a directory named *.jsonl
    LINK_JSONL, // a link named *.jsonl
    UNDER_LINKED_DIR, // a `subagents` folder that is a link
    MISSING, // not on disk
    '~/.claude/projects/-Users-x-repo/s1/subagents/agent-a1.jsonl',
    '$HOME/.claude/projects/-Users-x-repo/s1/subagents/agent-a1.jsonl',
  ]
  const calls = paths.flatMap((p) => [read(p), bash(`grep -c tool_use ${p}`), bash(`grep -c tool_use ${TRANSCRIPT} ${p}`)])
  expect(await through(gate, calls)).toEqual([])
})

test('block: no HOME, no transcript; the ledger calls do not need it', async ($, on) => {
  disk(on, {})
  on('tool.call', () => ({ result: {} }))
  const gate: Gate = (c) => $.tool.call(c as never)
  expect(await through(gate, [read(TRANSCRIPT), bash(`grep -c tool_use ${TRANSCRIPT}`)])).toEqual([])
  expect(await refused(gate, [bash(LIFT), bash(LIST)])).toEqual([])
})

test('block: the grep output is bounded (L2)', async ($, on) => {
  disk(on)
  on('tool.call', () => ({ result: {} }))
  const gate: Gate = (c) => $.tool.call(c as never)
  expect(await through(gate, [
    `grep -o . ${TRANSCRIPT}`, // the review's probe: no -m, so every line
    `grep -C 99999999 x ${TRANSCRIPT}`, // the review's probe
    `grep x ${TRANSCRIPT}`, // prints lines with no -m
    `grep -n -o -E tool_use ${TRANSCRIPT}`,
    `grep -m 11 x ${TRANSCRIPT}`,
    `grep -m 0 x ${TRANSCRIPT}`,
    `grep -c -m 99999999 x ${TRANSCRIPT}`, // the review's "huge -m"
    `grep -m 1 -A 3 x ${TRANSCRIPT}`,
    `grep -m 1 -B 3 x ${TRANSCRIPT}`,
    `grep -m 1 -C 3 x ${TRANSCRIPT}`,
    `grep -c x ${TRANSCRIPT} ${TRANSCRIPT} ${TRANSCRIPT} ${TRANSCRIPT} ${TRANSCRIPT} ${TRANSCRIPT}`, // 6 files
  ].map(bash))).toEqual([])
})

test('block: a pattern zsh would rewrite is refused (EXTENDED_GLOB caret, EQUALS)', async ($, on) => {
  disk(on)
  on('tool.call', () => ({ result: {} }))
  const gate: Gate = (c) => $.tool.call(c as never)
  expect(await through(gate, ['^x', 'a^b', '=ls', '-e ^x', '-e =ls'].map((p) => bash(`grep -c ${p} ${TRANSCRIPT}`)))).toEqual([])
  expect(await refused(gate, [bash(`grep -c a=b ${TRANSCRIPT}`)])).toEqual([])
})

test('block: the review\'s "checked and holding" inputs stay refused', async ($, on) => {
  disk(on)
  on('tool.call', () => ({ result: {} }))
  const gate: Gate = (c) => $.tool.call(c as never)
  expect(await through(gate, [
    `grep -e -f ${TRANSCRIPT}`,
    `grep -c -e x -f /etc/passwd ${TRANSCRIPT}`,
    `grep -m /etc/passwd x ${TRANSCRIPT}`,
    `grep -c -A x y ${TRANSCRIPT}`,
    `grep -c -A2 x ${TRANSCRIPT}`,
    `grep -c --include=x x ${TRANSCRIPT}`,
    `grep -rc x ${TRANSCRIPT}`,
    `grep -Rc x ${TRANSCRIPT}`,
    `grep -fc x ${TRANSCRIPT}`,
    `grep -c-r x ${TRANSCRIPT}`,
    `grep -c -- x ${TRANSCRIPT}`,
    `grep -c -x ${TRANSCRIPT}`,
    `grep -c -e x`,
    `grep -c a\tb ${TRANSCRIPT}`,
  ].map(bash))).toEqual([])
  expect(await refused(gate, [`grep -c -e a -e b ${TRANSCRIPT}`, `grep -c /etc/passwd ${TRANSCRIPT}`, `grep -c %1 ${TRANSCRIPT}`].map(bash))).toEqual([])
})

test('warn: the four reflection calls pass without a toast or a count, any other work tool is counted', { options: { main_mode: 'warn' } }, async ($, on) => {
  disk(on)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined as never }
  })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Read', file_path: TRANSCRIPT })
  await $.tool.call({ tool: 'Bash', command: LIFT })
  await $.tool.call({ tool: 'Bash', command: LIST })
  await $.tool.call({ tool: 'Bash', command: `grep -c tool_use ${TRANSCRIPT}` })
  expect(toasts).toEqual([])
  await $.tool.call({ tool: 'Bash', command: `${LIFT}; id` })
  await $.tool.call({ tool: 'Bash', command: `grep -c tool_use ${TRANSCRIPT}\t/etc/passwd` })
  await $.tool.call({ tool: 'Read', file_path: LINK_JSONL })
  expect(toasts).toEqual([
    'delegate: Bash on the main loop; delegate it',
    'delegate: Bash on the main loop; delegate it',
    'delegate: Read on the main loop; delegate it',
  ])
})

test('the system prompt gains the delegation section', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' as const }] }))
  const out = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
  expect(out.sections.at(-1)?.id).toBe('delegate:rules')
})
