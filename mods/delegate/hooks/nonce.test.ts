// The invariant (README, "When no model answers: you choose"): a pair is applied tagged `user` only if the user chose it
// in an AskUserQuestion whose questions carry the mod's mark, once, in the turn that asked. Every test below is an
// attack on it or a path around it.
import { expect, test } from 'claude-code/testing'

import { ABSENT, pane, spawn, wire } from './stub'
import type { Dollar } from './stub'

type Reply = { deny?: string }
const MODEL = /\[ask ([0-9a-z]+):model\]/
const refuse = async ($: Dollar, description: string): Promise<{ deny: string; nonce: string }> => {
  const out = (await spawn($, { description })) as Reply
  const nonce = MODEL.exec(out.deny ?? '')?.[1]
  return { deny: out.deny ?? '', nonce: nonce ?? '' }
}
// The main loop's AskUserQuestion, worded as the refusal says.
const askAs = ($: Dollar, name: string, nonce: string) =>
  $.tool.call({
    tool: 'AskUserQuestion',
    questions: [
      { question: `Which model for the agent "${name}"? [ask ${nonce}:model]`, header: 'Model', options: ['haiku', 'sonnet'].map((label) => ({ label, description: label })), multiSelect: false },
      { question: `Which effort for the agent "${name}"? [ask ${nonce}:effort]`, header: 'Effort', options: ['low', 'high'].map((label) => ({ label, description: label })), multiSelect: false },
    ],
  } as never)
const user = (model: string, effort: string) => (q: string) => (q.includes(':model]') ? model : q.includes(':effort]') ? effort : undefined)
const D = 'Review the guard'

test('the refusal carries a mark in each question, and the pair the retry names is not what is applied', async ($, on) => {
  const w = wire(on, { fm: [ABSENT], choose: user('sonnet', 'high') })
  const { deny, nonce } = await refuse($, D)
  expect(nonce).not.toBe('')
  expect(deny).toContain(`[ask ${nonce}:effort]`)
  await askAs($, D, nonce)
  await spawn($, { description: D, model: 'opus', effort: 'max' }) // names another pair: the user's is applied
  expect(w.sent).toEqual([{ model: 'sonnet', effort: 'high' }])
})

test('the user\'s answer is applied once, tagged user, and an effort that comes back as the answer to its question (max, typed under Other) counts', async ($, on) => {
  const w = wire(on, { fm: [ABSENT], choose: user('sonnet', 'max') })
  const { nonce } = await refuse($, 'Review the guard')
  await askAs($, 'Review the guard', nonce)
  await spawn($, { description: 'Review the guard' })
  expect(w.sent).toEqual([{ model: 'sonnet', effort: 'max' }])
  expect((await pane($)).lines[1]).toMatch(/sonnet → \? · max → \? · Review the guard \[user\]/)
  expect(((await spawn($, { description: 'Review the guard', model: 'sonnet', effort: 'max' })) as Reply).deny).toMatch(/AskUserQuestion/)
})

test('attack: a refusal obtained by anyone, then a pair named with no AskUserQuestion, is refused', async ($, on) => {
  const w = wire(on, { fm: [ABSENT] })
  await refuse($, D)
  const out = (await spawn($, { description: D, model: 'opus', effort: 'max' })) as Reply
  expect(out.deny).toMatch(/AskUserQuestion/)
  expect(w.sent).toEqual([])
  expect((await spawn($, { description: D, model: 'opus', effort: 'max' })) as Reply).toHaveProperty('deny')
  expect(w.sent).toEqual([])
})

test('attack: parallel retries after one answer apply one pair, once', async ($, on) => {
  const w = wire(on, { fm: [ABSENT], choose: user('sonnet', 'high') })
  const { nonce } = await refuse($, D)
  await askAs($, D, nonce)
  const outs = (await Promise.all(Array.from({ length: 6 }, () => spawn($, { description: D, model: 'opus', effort: 'max' })))) as Reply[]
  expect(w.sent).toEqual([{ model: 'sonnet', effort: 'high' }])
  expect(outs.filter((o) => o.deny === undefined)).toHaveLength(1)
})

test('attack: parallel retries with no answer apply nothing', async ($, on) => {
  const w = wire(on, { fm: [ABSENT] })
  await refuse($, D)
  await Promise.all(Array.from({ length: 6 }, () => spawn($, { description: D, model: 'opus', effort: 'max' })))
  expect(w.sent).toEqual([])
})

test('an answer is for the description it was asked about, and is spent by the call that used it', async ($, on) => {
  const w = wire(on, { fm: [ABSENT], choose: user('opus', 'xhigh') })
  const { nonce } = await refuse($, D)
  await askAs($, D, nonce)
  expect(((await spawn($, { description: 'Another task' })) as Reply).deny).toMatch(/AskUserQuestion/)
  await spawn($, { description: D })
  expect(((await spawn($, { description: D })) as Reply).deny).toMatch(/AskUserQuestion/)
  expect(w.sent).toEqual([{ model: 'opus', effort: 'xhigh' }])
})

test('attack: an AskUserQuestion with no mark, an unknown mark or a declined answer captures nothing', async ($, on) => {
  let say: (q: string) => string | undefined = () => 'opus'
  const w = wire(on, { fm: [ABSENT], choose: (q) => say(q) })
  const { nonce } = await refuse($, D)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: `Which model for the agent "${D}"?`, header: 'Model', options: [], multiSelect: false }] } as never)
  await askAs($, D, 'zzzzzz') // a mark the mod never issued
  say = () => undefined // the user declines
  await askAs($, D, nonce)
  expect(((await spawn($, { description: D, model: 'opus', effort: 'max' })) as Reply).deny).toMatch(/AskUserQuestion/)
  expect(w.sent).toEqual([])
})

test('an answer that is not a model and an effort captures nothing', async ($, on) => {
  const w = wire(on, { fm: [ABSENT], choose: user('gpt', 'low') })
  const { nonce } = await refuse($, D)
  await askAs($, D, nonce)
  expect(((await spawn($, { description: D, model: 'gpt', effort: 'low' })) as Reply).deny).toMatch(/AskUserQuestion/)
  expect(w.sent).toEqual([])
})

test('the answer expires with the turn that asked', async ($, on) => {
  const w = wire(on, { fm: [ABSENT], choose: user('sonnet', 'high') })
  const { nonce } = await refuse($, D)
  await askAs($, D, nonce)
  await $.turn.start({ text: 'next prompt', turnId: 't2' } as never)
  expect(((await spawn($, { description: D })) as Reply).deny).toMatch(/AskUserQuestion/)
  expect(w.sent).toEqual([])
})

test('a fault while the pending ask is read refuses the call, it never applies the caller\'s pair', async ($, on) => {
  const w = wire(on, { fm: [ABSENT], stateDown: true })
  const out = (await spawn($, { description: D, model: 'opus', effort: 'max' })) as Reply
  expect(out.deny).toBeDefined()
  expect(w.sent).toEqual([])
})
