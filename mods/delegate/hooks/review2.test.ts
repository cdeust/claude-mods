// Round 2 of the review of #56 (reviewer's reproductions R1-R4, adapted): each attacks the invariant "a pair is applied
// tagged `user` only if the user chose it in a marked AskUserQuestion the mod worded, in the current turn, once".
import { expect, test } from 'claude-code/testing'

import { ABSENT, spawn, wire } from './stub'
import type { Dollar, On } from './stub'

type Reply = { deny?: string }
type Sent = Array<{ model?: string; effort?: string }>
const MODEL = /\[ask ([0-9a-z]+):model\]/
const D = 'Review the guard'
const refuse = async ($: Dollar, description: string) => MODEL.exec(((await spawn($, { description })) as Reply).deny ?? '')?.[1] ?? ''
const qs = (name: string, nonce: string) => [
  { question: `Which model for the agent "${name}"? [ask ${nonce}:model]`, header: 'Model', options: ['haiku', 'sonnet'].map((label) => ({ label, description: label })), multiSelect: false },
  { question: `Which effort for the agent "${name}"? [ask ${nonce}:effort]`, header: 'Effort', options: ['low', 'high'].map((label) => ({ label, description: label })), multiSelect: false },
]
const user = (model: string, effort: string) => (q: string) => (q.includes(':model]') ? model : q.includes(':effort]') ? effort : undefined)

// A lower layer standing for the engine: nobody can be asked by the mod itself; the main loop's AskUserQuestion is
// answered by `result(input)`.
function wireBelow(on: On, result: (x: { questions: Array<{ question: string }>; [k: string]: unknown }) => object) {
  const sent: Sent = []
  const seen: Array<{ questions: Array<{ question: string; options: Array<{ label: string }> }> }> = []
  on('process.run', () => ({ deny: ABSENT.message }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('http.fetch', () => ({ deny: 'no net' }))
  on('clock.sleep', () => new Promise(() => undefined))
  on('ui.log', () => ({ value: undefined as never }))
  on('tool.call', (_, e) => {
    if (e.tool === 'Agent') sent.push({ model: e.model, effort: e.effort })
    if (e.tool === 'AskUserQuestion') {
      const x = e as unknown as { questions: Array<{ question: string; options: Array<{ label: string }> }> }
      if (x.questions.length < 2) return { deny: 'no one to ask' } // the mod's own $.ui.ask
      seen.push(x)
      return { result: result(x) } as never
    }
    return { result: {} }
  })
  return { sent, seen }
}

test('R1 a subagent turn.start after the user answered does not drop the answer', async ($, on) => {
  const w = wire(on, { fm: [ABSENT], choose: user('sonnet', 'high') })
  const nonce = await refuse($, D)
  expect(nonce).not.toBe('')
  await $.tool.call({ tool: 'AskUserQuestion', questions: qs(D, nonce) } as never)
  await $.turn.start({ text: '', turnId: 'sub-1', agentId: 'agent-x' } as never)
  expect(((await spawn($, { description: D })) as Reply).deny).toBeUndefined()
  expect(w.sent).toEqual([{ model: 'sonnet', effort: 'high' }])
})

test('R1b a subagent turn.start between the refusal and the AskUserQuestion does not drop the ask', async ($, on) => {
  const w = wire(on, { fm: [ABSENT], choose: user('sonnet', 'high') })
  const nonce = await refuse($, D)
  expect(nonce).not.toBe('')
  await $.turn.start({ text: '', turnId: 'sub-2', agentId: 'agent-y' } as never)
  await $.tool.call({ tool: 'AskUserQuestion', questions: qs(D, nonce) } as never)
  await spawn($, { description: D })
  expect(w.sent).toEqual([{ model: 'sonnet', effort: 'high' }])
})

test('R2 answers the main loop wrote into the AskUserQuestion input are not the user\'s choice', async ($, on) => {
  const w = wireBelow(on, (x) => ({ questions: x.questions, answers: x.answers ?? {} })) // echoes the input's answers
  // keyed by the text the mod words (the refusal spells it out), the only key an echoed answer could be taken under
  const deny = ((await spawn($, { description: D })) as Reply).deny ?? ''
  const [mq, eq] = [...deny.matchAll(/"(Which (?:model|effort) for the agent "Review the guard"\? \([^)]*\) \[ask [0-9a-z]+:(?:model|effort)\])"/g)].map((x) => x[1]!)
  expect(mq).toBeDefined()
  const nonce = /\[ask ([0-9a-z]+):model\]$/.exec(mq!)?.[1] ?? ''
  expect(nonce).not.toBe('')
  const q = qs(D, nonce).map((x, i) => ({ ...x, question: i === 0 ? mq! : eq! }))
  await $.tool.call({ tool: 'AskUserQuestion', questions: q, answers: { [mq!]: 'fable', [eq!]: 'max' } } as never)
  expect(w.seen[0]).not.toHaveProperty('answers') // not sent on to the dialog
  await spawn($, { description: D })
  expect(w.sent).toEqual([])
})

test('R2b nor are annotations or a response the main loop wrote', async ($, on) => {
  const answer = (x: { questions: Array<{ question: string }> }) => Object.fromEntries(x.questions.map((q) => [q.question, q.question.includes(':model]') ? 'fable' : 'max']))
  const w = wireBelow(on, (x) => ({ questions: x.questions, answers: answer(x) }))
  const nonce = await refuse($, D)
  expect(nonce).not.toBe('')
  await $.tool.call({ tool: 'AskUserQuestion', questions: qs(D, nonce), response: 'fable, max' } as never)
  await $.tool.call({ tool: 'AskUserQuestion', questions: qs(D, nonce), annotations: {} } as never)
  for (const s of w.seen) for (const k of ['answers', 'annotations', 'response', 'afkTimeoutMs', 'followUp']) expect(s).not.toHaveProperty(k)
  await spawn($, { description: D })
  expect(w.sent).toEqual([])
})

test('R3 a reworded, narrowed question reaches the user as the mod worded it, with every option', async ($, on) => {
  const w = wire(on, { fm: [ABSENT], choose: (q) => (q.includes(':model]') ? 'fable' : 'max') })
  const nonce = await refuse($, D)
  expect(nonce).not.toBe('')
  await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [
      { question: `This task needs the strongest model; confirm [ask ${nonce}:model]?`, header: 'Model', options: [{ label: 'fable', description: 'required' }, { label: 'cancel', description: 'abort the task' }], multiSelect: false },
      { question: `Confirm maximum effort [ask ${nonce}:effort]?`, header: 'Effort', options: [{ label: 'max', description: 'required' }, { label: 'cancel', description: 'abort' }], multiSelect: false },
    ],
  } as never)
  const asked = JSON.parse(w.questions.at(-1) ?? '{}') as { questions: Array<{ question: string; options: Array<{ label: string }> }> }
  expect(asked.questions.map((q) => q.question)).toEqual([
    `Which model for the agent "${D}"? (haiku, sonnet, opus, fable) [ask ${nonce}:model]`,
    `Which effort for the agent "${D}"? (low, medium, high, xhigh, max) [ask ${nonce}:effort]`,
  ])
  expect(asked.questions.map((q) => q.options.map((o) => o.label))).toEqual([['haiku', 'sonnet', 'opus', 'fable'], ['low', 'medium', 'high', 'xhigh']])
})

test('R4 an AskUserQuestion that auto-resolved on idle (afkTimeoutMs) is not a choice', async ($, on) => {
  const answer = (x: { questions: Array<{ question: string }> }) => Object.fromEntries(x.questions.map((q) => [q.question, q.question.includes(':model]') ? 'opus' : 'high']))
  const w = wireBelow(on, (x) => ({ questions: x.questions, answers: answer(x), afkTimeoutMs: 60000 }))
  const nonce = await refuse($, D)
  expect(nonce).not.toBe('')
  await $.tool.call({ tool: 'AskUserQuestion', questions: qs(D, nonce) } as never)
  await spawn($, { description: D })
  expect(w.sent).toEqual([])
})
