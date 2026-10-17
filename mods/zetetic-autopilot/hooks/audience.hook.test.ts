import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { ENFORCE, ENGINEER, QUOTA, freshSeen, spawn, stubs } from './harness'

// Audience (the engine's declarations, `claude-code` types): `$.ui.toast` "leaves the transcript and the model
// untouched" (the user alone reads it); a tool.call result's `context` is "what the model reads after the tool's
// result and the user never sees" (the model alone reads it); an agent.spawn `deny` is "the Agent tool's error" the
// model reads. Each text below goes through the one API whose reader it is written for.

const edit = { tool: 'Edit', file_path: '/r/src/a.ts', old_string: 'a', new_string: 'b' }
const IMPERATIVE = /delegate|should|must|wait|again|spawn this/i

type Ran = { deny?: string; context?: readonly string[]; ref?: number; text?: string }
type Engine = Parameters<TestBody>[0]
const call = ($: Engine, input: object = edit) => $.tool.call(input as never) as unknown as Promise<Ran>

// A tool that answers as the engine's does, with the `ref` and `text` core sets on what `next` resolves to.
const running = (on: Parameters<TestBody>[1]) => on('tool.call', () => ({ result: 'ok', text: 'ok', ref: 7 }) as never)

test('the delegation rule reaches Claude as context, and the user is told only the fact', { options: ENFORCE }, async ($, on) => {
  const seen = freshSeen()
  stubs(on, seen)
  running(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  const ran = await call($)
  // Claude: the instruction, in the tool result's context.
  expect(ran.context).toHaveLength(1)
  expect(ran.context?.[0]).toMatch(/subagent/)
  expect(ran.context?.[0]).toMatch(/delegate/i)
  // The user: the fact, a toast with no instruction in it, and not the text Claude reads.
  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toContain('main ran Edit')
  expect(seen.toasts[0]).not.toMatch(IMPERATIVE)
  expect(seen.toasts[0]).not.toBe(ran.context?.[0])
  // The result is core's own, kept whole: the messages `ref` names are used verbatim.
  expect(ran).toMatchObject({ ref: 7, text: 'ok' })
})

test('the reminder and the toast come once a turn: the second call of the turn has neither, the next turn both', { options: ENFORCE }, async ($, on) => {
  const seen = freshSeen()
  stubs(on, seen)
  running(on)
  on('turn.step', async function* ($$, e) {
    yield { kind: 'text', index: 0, text: '' }
    return { turnId: e.turnId, index: e.index, answer: 'done', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  const step = async (turnId: string) => {
    const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 1 })
    let r = await stream.next()
    while (r.done !== true) r = await stream.next()
  }
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await step('t1')
  expect((await call($)).context).toHaveLength(1)
  expect((await call($)).context).toBeUndefined()
  expect((await call($)).context).toBeUndefined()
  expect(seen.toasts).toHaveLength(1)
  // Every call is still a POLICY row.
  expect(seen.decisions.filter((d) => d.kind === 'work')).toHaveLength(3)
  await step('t2')
  expect((await call($)).context).toHaveLength(1)
  expect(seen.toasts).toHaveLength(2)
})

test('a call that was refused carries no reminder and does not use the turn up: the next call does', { options: ENFORCE }, async ($, on) => {
  const seen = freshSeen()
  stubs(on, seen)
  let refuse = true
  on('tool.call', () => (refuse ? { deny: 'not allowed' } : { result: 'ok', text: 'ok', ref: 7 }) as never)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  const refused = await call($)
  expect(refused).toEqual({ deny: 'not allowed' })
  refuse = false
  expect((await call($)).context).toHaveLength(1)
  expect((await call($)).context).toBeUndefined()
})

test('a read, a check and a subagent writing code carry no reminder', { options: ENFORCE }, async ($, on) => {
  const seen = freshSeen()
  stubs(on, seen)
  running(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  expect((await call($, { tool: 'Read', file_path: '/r/a.ts' })).context).toBeUndefined()
  expect((await call($, { tool: 'Bash', command: 'git status' })).context).toBeUndefined()
  expect((await call($, { ...edit, agentId: 'ag-9' })).context).toBeUndefined()
  expect(seen.toasts).toEqual([])
})

test('the cap refusal: the user reads the fact, Claude reads the fact and the way out, and the two differ', { options: ENFORCE }, async ($, on) => {
  const seen = freshSeen()
  stubs(on, seen)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.session.measure(QUOTA)
  await $.agent.spawn(spawn(ENGINEER, 'haiku'))
  const refused = await $.agent.spawn(spawn(ENGINEER, 'haiku'))
  expect(seen.toasts).toHaveLength(1)
  const [toast] = seen.toasts
  // Claude: the count, the cap, the quota and the instruction, as the Agent tool's error.
  expect(refused.deny).toContain('1 subagent is running and the cap is 1 at 90%')
  expect(refused.deny).toContain('Wait for a running agent to finish, then spawn this one again.')
  // The user: the same fact, and no order to a reader that cannot act on it.
  expect(toast).toContain(ENGINEER)
  expect(toast).toContain('1 subagent running')
  expect(toast).toContain('cap 1')
  expect(toast).toContain('90%')
  expect(toast).not.toMatch(/wait|again|spawn this/i)
  expect(toast).not.toBe(refused.deny)
  // The POLICY row is the user's too: it states the fact.
  expect(seen.decisions.find((d) => d.kind === 'cap')?.reason).toBe(toast)
})
