import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { DEADLINE_MS, MAX_BRIEF, OVERFLOW } from './fm'

// `$.process.run` is stubbed through its own event, the bottom of the chain: what the mod passes to it arrives here
// with its argv and its stdin. Replies go in order and the last repeats; an Error is a rejection (the stub's `deny`),
// as the engine rejects a command that cannot start or that outlives its timeout.
type Reply = { exitCode: number; stdout?: string; stderr?: string } | Error
type Call = { argv: readonly string[]; stdin?: string; timeoutMs?: number }

const answer = (cls: string, reason = 'because'): Reply => ({ exitCode: 0, stdout: JSON.stringify({ class: cls, reason }) })
const ABSENT = new Error('HooksError: delegate: $.process.run(/usr/bin/fm) failed to start: ENOENT: no such file or directory')
const TIMEOUT = new Error('HooksError: delegate: $.process.run(/usr/bin/fm) aborted: still running after 4000ms')
const OVER: Reply = { exitCode: 1, stderr: `Error: The session's transcript ${OVERFLOW}.` }

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

function setup(on: On, replies: Reply[]) {
  const calls: Call[] = []
  const sent: Array<{ model?: string; effort?: string }> = []
  on('process.run', (_, e) => {
    calls.push({ argv: e.argv, stdin: e.init?.stdin, timeoutMs: e.init?.timeoutMs })
    const r = replies[Math.min(calls.length - 1, replies.length - 1)] as Reply
    if (r instanceof Error) return { deny: r.message }
    const value = { stdout: '', stderr: '', ...r, isStdoutTruncated: false, isStderrTruncated: false }
    return { value }
  })
  on('tool.call', (_, e) => {
    if (e.tool === 'Agent') sent.push({ model: e.model, effort: e.effort })
    return { result: {} }
  })
  on('ui.log', () => ({ value: undefined as never }))
  return { calls, sent }
}

let n = 0
const spawn = ($: Dollar, fields: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'Agent', tool_use_id: `u${++n}`, description: 'Do the task', prompt: 'p', ...fields } as never)

// The pane is where a row's decision shows: the line (decided pair, instrument, what was asked) and its reason.
const PANE = {
  plugin: 'delegate',
  component: 'Pane',
  requestId: 'delegate',
  surface: 'terminal',
  props: { title: 'Delegation', isFocused: false, bodyColumns: 200, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const pane = async ($: Dollar) => {
  const ui = await $.ui.mount(PANE as never)
  const lines = (await ui.findAll({ type: 'Text', text: /\[(fm|regex|default|caller)\]/ })).map((x) => x.text)
  const reasons = (await ui.findAll({ type: 'Text', text: /↳/ })).map((x) => x.text)
  await ui.unmount()
  return { lines, reasons }
}

test('fm decides over a caller-named pair, and both are recorded', async ($, on) => {
  const { calls, sent } = setup(on, [answer('judge', 'measures an effect')])
  const started = Date.now()
  await spawn($, { description: 'Look up the latency', model: 'haiku', effort: 'low' })
  const elapsed = Date.now() - started

  expect(sent).toEqual([{ model: 'opus', effort: 'high' }])
  const { lines, reasons } = await pane($)
  expect(lines[0]).toMatch(/opus → \? · high → \? · Look up the latency \[fm\]\s*\(asked haiku\/low\)/)
  expect(reasons[0]).toMatch(/↳ judge: measures an effect/)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.argv.slice(0, 4)).toEqual(['/usr/bin/fm', 'respond', '--no-stream', '--greedy'])
  expect(calls[0]?.argv).toContain('--schema')
  // The deadline runs from the enqueue (fm.test.ts): fm gets what is left of it, never more, and at most the
  // wall time this call took is gone. An exact 4000 fails whenever a millisecond passes (CI run 40852365808: 3999).
  const timeoutMs = calls[0]?.timeoutMs ?? 0
  expect(timeoutMs).toBeLessThanOrEqual(DEADLINE_MS)
  expect(DEADLINE_MS - elapsed).toBeLessThanOrEqual(timeoutMs)
})

test('the brief goes to fm on stdin, not on argv', async ($, on) => {
  const { calls } = setup(on, [answer('read')])
  await spawn($, { description: 'List the files', prompt: 'SECRET-BRIEF-TEXT', subagent_type: 'Explore' })
  expect(calls[0]?.stdin).toContain('SECRET-BRIEF-TEXT')
  expect(calls[0]?.stdin).toContain('subagent_type: Explore')
  expect(calls[0]?.argv.join(' ')).not.toContain('SECRET-BRIEF-TEXT')
})

for (const [cls, model, effort] of [['read', 'haiku', 'low'], ['build', 'sonnet', 'medium'], ['judge', 'opus', 'high'], ['critical', 'opus', 'xhigh']] as const) {
  test(`class ${cls} is ${model} at ${effort}`, async ($, on) => {
    const { sent } = setup(on, [answer(cls)])
    await spawn($)
    expect(sent).toEqual([{ model, effort }])
  })
}

test('a caller naming only the model gets fm\'s pair, never a mix', async ($, on) => {
  const { sent } = setup(on, [answer('build')])
  await spawn($, { model: 'opus' })
  expect(sent).toEqual([{ model: 'sonnet', effort: 'medium' }])
  expect((await pane($)).lines[0]).toMatch(/\(asked opus\/-\)/)
})

test('a caller naming only the effort gets fm\'s pair too', async ($, on) => {
  const { sent } = setup(on, [answer('read')])
  await spawn($, { effort: 'max' })
  expect(sent).toEqual([{ model: 'haiku', effort: 'low' }])
  expect((await pane($)).lines[0]).toMatch(/\(asked -\/max\)/)
})

test('a timeout falls back to the regex, tagged fm-timeout', async ($, on) => {
  const { sent } = setup(on, [TIMEOUT])
  await spawn($, { description: 'Crawl the docs', model: 'opus', effort: 'high' })
  expect(sent).toEqual([{ model: 'haiku', effort: 'low' }])
  const { lines, reasons } = await pane($)
  expect(lines[0]).toMatch(/\[regex\]\s*\(asked opus\/high\)/)
  expect(reasons[0]).toMatch(/↳ fm-timeout;/)
})

test('a non-zero exit, and unparseable output, fall back to the regex with their reason', async ($, on) => {
  const { sent } = setup(on, [{ exitCode: 1, stderr: 'Error: boom' }, { exitCode: 0, stdout: 'not json' }, { exitCode: 0, stdout: '{"class":"nonsense","reason":"x"}' }])
  await spawn($, { description: 'Fix the bug' })
  await spawn($, { description: 'Fix the bug' })
  await spawn($, { description: 'Fix the bug' })
  const { reasons } = await pane($)
  expect(reasons.map((r) => r.match(/↳ (fm-[a-z]+)/)?.[1])).toEqual(['fm-exit', 'fm-unparseable', 'fm-unparseable'])
  expect(sent).toEqual([{ model: 'sonnet', effort: 'medium' }, { model: 'sonnet', effort: 'medium' }, { model: 'sonnet', effort: 'medium' }])
})

test('an unclassified task with no fm answer is the default, not a regex hit', async ($, on) => {
  setup(on, [{ exitCode: 1 }])
  await spawn($, { description: 'Do the thing' })
  expect((await pane($)).lines[0]).toMatch(/sonnet → \? · medium → \? · Do the thing \[default\]/)
})

test('with no fm binary, the regex decides for the rest of the session and fm is not asked again', async ($, on) => {
  const { calls, sent } = setup(on, [ABSENT])
  await spawn($, { description: 'Crawl the docs' })
  await spawn($, { description: 'Implement the guard' })
  expect(calls).toHaveLength(1)
  expect(sent).toEqual([{ model: 'haiku', effort: 'low' }, { model: 'sonnet', effort: 'medium' }])
  expect((await pane($)).reasons.map((r) => r.match(/↳ (fm-[a-z]+)/)?.[1])).toEqual(['fm-absent', 'fm-absent'])
})

test('a fork and a custom type are the caller\'s: fm is not asked, nothing is rewritten', async ($, on) => {
  const { calls, sent } = setup(on, [answer('critical')])
  await spawn($, { subagent_type: 'fork' })
  await spawn($, { subagent_type: 'zetetic:reviewer', model: 'sonnet' })
  expect(calls).toHaveLength(0)
  expect(sent).toEqual([{ model: undefined, effort: undefined }, { model: 'sonnet', effort: undefined }])
  expect((await pane($)).lines.map((l) => l.match(/\[(\w+)\]/)?.[1])).toEqual(['caller', 'caller'])
})

test('classifier=regex never calls fm', { options: { classifier: 'regex' } }, async ($, on) => {
  const { calls, sent } = setup(on, [answer('critical')])
  await spawn($, { description: 'Security review of the hook', model: 'haiku' })
  expect(sent).toEqual([{ model: 'opus', effort: 'high' }])
  expect(calls).toHaveLength(0)
  const { lines, reasons } = await pane($)
  expect(lines[0]).toMatch(/\(asked haiku\/-\)/)
  expect(reasons[0]).toMatch(/↳ classifier=regex;/)
})

test('the section tells the main loop that the mod decides', async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))
  const out = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
  const text = out.sections.at(-1)?.text ?? ''
  expect(text).toMatch(/decides each subagent's model and effort/)
  expect(text).toMatch(/recorded as a request/)
  expect(text).not.toMatch(/Every Agent call names both/)
})
