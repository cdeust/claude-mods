import { expect, test } from 'claude-code/testing'

import { FRICTION_MAX_BYTES, FRICTION_TOP, frictionScan, frictionsOf, recurringFrictions, isUnavailable, recurringOver, rowsOf, signatureOf, toolErrorKind } from './friction'

// Line shapes are the real ones (read from a Claude Code transcript 2026-10-14), every value made up.
const use = (id: string, name: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] } })
const result = (id: string, content: unknown, isError = true) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content, is_error: isError, tool_use_id: id }] } })
const attach = (attachment: Record<string, unknown>) => JSON.stringify({ type: 'attachment', attachment, uuid: 'u', sessionId: 's' })
const blocking = (text: string) =>
  attach({ type: 'hook_blocking_error', hookName: 'Stop', hookEvent: 'Stop', blockingError: { blockingError: text, command: 'python3 "${CLAUDE_PLUGIN_ROOT}/hooks/gate.py" hook Stop' } })

const FIXTURE = [
  use('toolu_01AAAA', 'Bash'),
  result('toolu_01AAAA', 'Exit code 1\nls: nope: No such file or directory'), // a command's own exit: not a friction
  use('toolu_01BBBB', 'Bash'),
  result('toolu_01BBBB', 'Permission to use Bash with command rm -rf /tmp/x has been denied.'),
  use('toolu_01CCCC', 'Edit'),
  result('toolu_01CCCC', 'File has not been read yet. Read it first before writing to it.'),
  use('toolu_01DDDD', 'mcp__srv__tool'),
  result('toolu_01DDDD', [{ type: 'text', text: 'boom 42\nsecond line' }]),
  use('toolu_01EEEE', 'Read'),
  result('toolu_01EEEE', 'file contents', false), // not an error
  blocking('Owned cleanup remains: [{"path": "/Users/a/scratch/x1", "protected": "p"}]'),
  blocking('Owned cleanup remains: [{"path": "/Users/b/scratch/y22", "protected": "q"}]'),
  attach({ type: 'hook_non_blocking_error', hookName: 'Stop', hookEvent: 'Stop', stderr: 'Failed to run: Plugin directory does not exist: /Users/a/.claude/plugins/cache/m/p/2.1.0 (p@m run /plugin to reinstall)', stdout: '', exitCode: 1, command: 'python3 x.py', durationMs: 11 }),
  attach({ type: 'hook_cancelled', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', command: 'python3 /Users/a/hooks/claude_dir_doctor.py', durationMs: 5037, timedOut: true, timeoutMs: 5000 }),
  attach({ type: 'hook_success', hookName: 'Stop', hookEvent: 'Stop', content: 'ok', exitCode: 0 }),
  '{"type":"attachment","attachment":{"type":"hook_cancelled","hookName":"Stop"', // cut short: malformed
  'not json at all',
  '',
].join('\n')

test('a transcript gives exactly its frictions: each hook kind, a refusal, a misuse, an MCP failure; not a bare exit, not a success', () => {
  expect(frictionsOf(FIXTURE)).toEqual([
    { kind: 'hook-block', signature: 'Owned cleanup remains: [{<Q>: <Q>, <Q>: <Q>}]', count: 2 },
    { kind: 'harness-refusal', signature: 'Permission to use Bash with command <CMD> has been denied', count: 1 },
    { kind: 'hook-cancelled', signature: 'SessionStart:startup: claude_dir_doctor.py timed out', count: 1 },
    { kind: 'hook-error', signature: 'Failed to run: Plugin directory does not exist: <PATH> (p@m run <PATH> to reinstall)', count: 1 },
    { kind: 'mcp-failure', signature: 'boom N', count: 1 },
    { kind: 'tool-misuse', signature: 'File has not been read yet. Read it first before writing to it.', count: 1 },
  ])
})

test('a malformed line that could hold a friction is skipped and counted, never thrown; the rest is read', () => {
  expect(frictionScan(FIXTURE).skipped).toBe(1)
  expect(frictionScan('{"type":"attachment","attachment":{"type":"hook_blocking_error"').rows).toEqual([])
})

test('total over any input', () => {
  for (const bad of ['', '\n\n', '[]', 'null', '{"attachment":5}', '{"type":"attachment"}', '{"type":"attachment","attachment":null}', '{"message":{"content":"x"}}', '"tool_result"', '{"message":{"content":[null,5,{"type":"tool_result","is_error":true}]}}'])
    expect(() => frictionsOf(bad)).not.toThrow()
  expect(frictionsOf('')).toEqual([])
  expect(frictionsOf(undefined as unknown as string)).toEqual([])
  expect(frictionsOf(null as unknown as string)).toEqual([])
})

test('the signature is normalised in order: quoted strings, paths, hex runs, tool ids, numbers; then cut to 120', () => {
  expect(signatureOf('blocked "/Users/a/x" and \'single quoted\' and `ticks`')).toBe('blocked <Q> and <Q> and <Q>') // a quoted path is one <Q>, not <PATH>
  expect(signatureOf('read /Users/a/b.txt and ~/c/d then /plugin')).toBe('read <PATH> and <PATH> then <PATH>')
  expect(signatureOf("it's and/or fine, don't")).toBe("it's and/or fine, don't") // an apostrophe in prose is not a quote
  expect(signatureOf('commit deadbeef01 and 0123456789abcdef; short abc1234')).toBe('commit <HEX> and <HEX>; short abc1234')
  expect(signatureOf('tool toolu_01HUNjX8abc failed')).toBe('tool <ID> failed')
  expect(signatureOf('retry 3 of 10 after 2.5 s, version 2.1.0')).toBe('retry N of N after N s, version N')
  expect(signatureOf('\n\n  first real line  \nsecond')).toBe('first real line')
  expect(signatureOf('x'.repeat(300))).toHaveLength(120)
  expect(signatureOf('')).toBe('')
})

test('the same event on another path, number or id is one signature', () => {
  const a = frictionsOf([blocking('Owned cleanup remains: 3 at /Users/a/1'), blocking('Owned cleanup remains: 17 at /Users/b/22')].join('\n'))
  expect(a).toEqual([{ kind: 'hook-block', signature: 'Owned cleanup remains: N at <PATH>', count: 2 }])
})

test('a hook event says what it says in blockingError (text or nested), else stderr, else content', () => {
  const lines = [
    attach({ type: 'hook_blocking_error', blockingError: 'plain string' }),
    attach({ type: 'hook_blocking_error', stderr: 'from stderr', blockingError: { blockingError: '', command: 'c' } }),
    attach({ type: 'hook_blocking_error', content: '\nfrom content\nmore' }),
  ].join('\n')
  expect(frictionsOf(lines).map((r) => r.signature)).toEqual(['from content', 'from stderr', 'plain string'])
})

test('the closed tool-error rules', () => {
  expect(toolErrorKind('Bash', 'Exit code 1')).toBeNull()
  expect(toolErrorKind('Bash', 'Exit code 2\nrm: cannot remove: Permission denied')).toBeNull() // the command's output, not the harness
  expect(toolErrorKind('Bash', 'PreToolUse:Bash hook error: [x]: Bash blocked: no')).toBe('harness-refusal')
  expect(toolErrorKind('Write', 'Tool use not allowed here')).toBe('harness-refusal')
  expect(toolErrorKind('Edit', 'String to replace not found in file.')).toBe('tool-misuse')
  expect(toolErrorKind('Read', 'InputValidationError: bad')).toBe('tool-misuse')
  expect(toolErrorKind('Task', 'unknown parameter foo')).toBe('tool-misuse')
  expect(toolErrorKind('mcp__a__b', 'anything')).toBe('mcp-failure')
  expect(toolErrorKind('WebFetch', 'connection reset')).toBe('mcp-failure')
  expect(toolErrorKind('WebFetch', 'request timed out')).toBe('mcp-failure')
  expect(toolErrorKind('Read', 'ENOENT: no such file')).toBeNull() // anything else is ignored
  expect(toolErrorKind('', 'Exit code 1')).toBe(null)
  expect(toolErrorKind('mcp__a__b', 'Permission denied by server')).toBe('harness-refusal') // refusal first, as the rules are ordered
})

test('a result joins its tool_use by id, across lines; an unknown id is a tool with no name', () => {
  const lines = [result('toolu_orphan', 'Exit code 3'), use('toolu_1', 'Bash'), result('toolu_1', 'Exit code 3')].join('\n')
  expect(frictionsOf(lines)).toEqual([])
  expect(frictionsOf(result('toolu_orphan', 'connection lost'))).toEqual([{ kind: 'mcp-failure', signature: 'connection lost', count: 1 }])
})

test('at most FRICTION_TOP rows, the most frequent first, ties in a fixed order', () => {
  const many = Array.from({ length: 40 }, (_, i) => blocking(`distinct ${'x'.repeat(i % 7)}${String.fromCharCode(97 + (i % 26))}${'y'.repeat(i)}`))
  const hot = Array.from({ length: 3 }, () => blocking('hot one'))
  const rows = frictionsOf([...many, ...hot].join('\n'))
  expect(rows).toHaveLength(FRICTION_TOP)
  expect(rows[0]).toEqual({ kind: 'hook-block', signature: 'hot one', count: 3 })
  expect(frictionsOf([...many, ...hot].reverse().join('\n'))).toEqual(rows) // the same file's lines in another arrival order: the same rows
})

test('recurring: a row in at least 2 sessions, most sessions then most occurrences, top 10; a session counts a row once', () => {
  const f = (signature: string, count: number, kind: 'hook-block' | 'hook-error' = 'hook-block') => ({ kind, signature, count })
  const rows = recurringFrictions([
    [f('everywhere', 1), f('twice', 5), f('once', 9)],
    [f('everywhere', 2), f('twice', 1)],
    [f('everywhere', 1), f('other', 1), f('other', 1)], // the same row twice in one session is one session
    [f('everywhere', 1, 'hook-error'), f('other', 1)],
  ])
  expect(rows).toEqual([
    { kind: 'hook-block', signature: 'everywhere', sessions: 3, count: 4 },
    { kind: 'hook-block', signature: 'twice', sessions: 2, count: 6 },
    { kind: 'hook-block', signature: 'other', sessions: 2, count: 3 },
  ])
  expect(recurringFrictions([])).toEqual([])
  expect(recurringFrictions([[f('a', 1)]])).toEqual([])
  const wide = Array.from({ length: 15 }, (_, i) => f(`row ${String(i).padStart(2, '0')}`, 1))
  expect(recurringFrictions([wide, wide])).toHaveLength(10)
})

test('recurringOver reads the sessions asked for, ignoring a session with nothing stored; rowsOf reads damage as no rows', () => {
  const stored = new Map([
    ['a', [{ kind: 'hook-block' as const, signature: 's', count: 1 }]],
    ['b', [{ kind: 'hook-block' as const, signature: 's', count: 1 }]],
    ['c', [{ kind: 'hook-block' as const, signature: 's', count: 1 }]],
  ])
  expect(recurringOver(stored, ['a', 'b', 'missing'])).toEqual([{ kind: 'hook-block', signature: 's', sessions: 2, count: 2 }])
  expect(recurringOver(stored, ['a', 'missing'])).toEqual([])
  expect(rowsOf('junk')).toEqual([])
  expect(rowsOf([null, 5, { kind: 'x' }, { kind: 'hook-block', signature: 's', count: 2 }])).toEqual([{ kind: 'hook-block', signature: 's', count: 2 }])
})

test('a permission denial keeps the tool and drops the command, so denials of any command are one signature', () => {
  // The two real samples, values made up.
  const one = 'Permission to use Bash with command A=~/x; B=/y/z; export K=v; curl -s http://127.0.0.1:9/a | python3 -c "print(1)" has been denied.'
  const two = 'Permission to use Bash with command rm -rf /tmp/q\nsecond line of the command has been denied.'
  expect(signatureOf(one)).toBe('Permission to use Bash with command <CMD> has been denied')
  expect(signatureOf(two)).toBe('Permission to use Bash with command <CMD> has been denied')
  expect(signatureOf('Permission to use mcp__a__b with command x has been denied.')).toBe('Permission to use mcp__a__b with command <CMD> has been denied')
  const lines = [two, one].map((t, i) => result(`toolu_0${i}`, t)).join('\n')
  expect(frictionsOf(lines)).toEqual([{ kind: 'harness-refusal', signature: 'Permission to use Bash with command <CMD> has been denied', count: 2 }])
})

test('a hook-blocked call keeps the tool, the gate and its first sentence, and drops the hook command', () => {
  const a = `PreToolUse:Write hook error: [bash -c 'PY=$(command -v python3) && [ -z "\${ROOT:-}" ] && "$PY" "$ROOT/gate.py"']: [decision-gate] BLOCKED: /Users/a/m/f.ts:1 would add 12 consecutive comment lines. A block that long is a decision.`
  const b = `PreToolUse:Write hook error: [bash -c 'other command']: [decision-gate] BLOCKED: /Users/b/n/g.ts:1 would add 30 consecutive comment lines. Record it first.\nmore`
  expect(signatureOf(a)).toBe('PreToolUse:Write hook error: [decision-gate] BLOCKED: <PATH> would add N consecutive comment lines')
  expect(signatureOf(b)).toBe(signatureOf(a))
  expect(signatureOf('PreToolUse:Bash hook error: [c]: no sentence end')).toBe('PreToolUse:Bash hook error: no sentence end')
  expect(frictionsOf([result('toolu_1', a), result('toolu_2', b)].join('\n'))).toEqual([{ kind: 'harness-refusal', signature: 'PreToolUse:Write hook error: [decision-gate] BLOCKED: <PATH> would add N consecutive comment lines', count: 2 }])
})

test('the unavailable marker is a measured session with no rows; the cap is 20 MiB', () => {
  expect(FRICTION_MAX_BYTES).toBe(20 * 1024 * 1024)
  expect(isUnavailable({ unavailable: 'missing' })).toBe(true)
  expect(isUnavailable({ unavailable: 'too-large' })).toBe(true)
  expect(isUnavailable({ unavailable: 'other' })).toBe(false)
  expect(isUnavailable([])).toBe(false)
  expect(rowsOf({ unavailable: 'missing' })).toEqual([])
})
