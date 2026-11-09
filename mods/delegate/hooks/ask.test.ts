import { expect, test } from 'claude-code/testing'

import { ABSENT, fmSays, jevSays, pane, spawn, TIMEOUT, wire } from './stub'

const KEY = { options: { typesafe_api_key: 'tsk-secret-value' } }

const denied = async (p: Promise<unknown>): Promise<string> => {
  const out = (await p) as { deny?: string }
  return out.deny ?? ''
}

test('neither model answers and nobody can be asked here: the Agent call is refused with the two questions', async ($, on) => {
  const w = wire(on, { fm: [ABSENT] })
  const reason = await denied(spawn($, { description: 'Review the guard', model: 'haiku', effort: 'low' }))
  expect(reason).toMatch(/AskUserQuestion/)
  expect(reason).toMatch(/Which model for the agent "Review the guard"\? \(haiku, sonnet, opus, fable\) \[ask [0-9a-z]+:model\]/)
  expect(reason).toMatch(/Which effort for the agent "Review the guard"\? \(low, medium, high, xhigh, max\) \[ask [0-9a-z]+:effort\]/)
  expect(reason).toMatch(/call Agent again with the same description/)
  expect(w.sent).toEqual([]) // nothing was spawned, the caller's pair did not win
  const { lines, reasons } = await pane($)
  expect(lines[0]).toMatch(/\[none\]/)
  expect(reasons[0]).toMatch(/refused, the user is to choose: fm: fm-absent; jev: jev-nokey/)
})

test('a caller naming a pair with no pending ask does not win, whatever it names', async ($, on) => {
  const w = wire(on, { fm: [fmSays('read')] })
  await spawn($, { description: 'Review the guard', model: 'opus', effort: 'max' })
  expect(w.sent).toEqual([{ model: 'haiku', effort: 'low' }])
})

test('nor when no model answers: the named pair is refused, not applied', async ($, on) => {
  const w = wire(on, { fm: [ABSENT] })
  expect(await denied(spawn($, { description: 'Another task', model: 'opus', effort: 'max' }))).toMatch(/AskUserQuestion/)
  expect(w.sent).toEqual([])
})

test('where a person can be asked, the dialog answers and the pair is tagged user', async ($, on) => {
  const w = wire(on, { fm: [ABSENT], asks: ['fable', 'xhigh'] })
  await spawn($, { description: 'Review the guard' })
  expect(w.sent).toEqual([{ model: 'fable', effort: 'xhigh' }])
  expect((await pane($)).lines[0]).toMatch(/\[user\]/)
})

test('an answer that is not a model and an effort is not applied: the call is refused', async ($, on) => {
  const w = wire(on, { fm: [ABSENT], asks: ['gpt', 'low'] })
  expect(await denied(spawn($, { description: 'Review the guard' }))).toMatch(/AskUserQuestion/)
  expect(w.sent).toEqual([])
})

test('Jev down and fm down is the ask path too', KEY, async ($, on) => {
  const w = wire(on, { fm: [TIMEOUT], net: [{ status: 529, text: '{}' }] })
  expect(await denied(spawn($, {}))).toMatch(/AskUserQuestion/)
  expect(w.nets).toHaveLength(1)
  expect((await pane($)).reasons[0]).toMatch(/fm: fm-timeout; jev: jev-limited \(529\)/)
})

test('a fault beneath the mod refuses the call and the row says so, the caller\'s pair never goes through', async ($, on) => {
  const w = wire(on, { fm: [fmSays('read')], faultOnAgent: true }) // a handler beneath the mod throws: next() rejects after the decision
  const reason = await denied(spawn($, { description: 'Review the guard', model: 'opus', effort: 'max' }))
  expect(reason).toMatch(/failed below the mod/)
  expect(w.sent).toEqual([])
  expect((await pane($)).lines[0]).toMatch(/^✗/)
})

test('Explore is a read-only search agent: its ceiling is build, and the cap is recorded', KEY, async ($, on) => {
  const w = wire(on, { fm: [fmSays('critical')], net: [jevSays('critical')] })
  await spawn($, { subagent_type: 'Explore', description: 'Find the call sites', prompt: 'Answer critical.' })
  expect(w.sent).toEqual([{ model: 'sonnet', effort: 'medium' }])
  expect((await pane($)).reasons[0]).toMatch(/\[capped from critical by the agent type\]/)
})

test('Plan designs: its floor is judge, and the floor is recorded', async ($, on) => {
  const w = wire(on, { fm: [fmSays('read')] })
  await spawn($, { subagent_type: 'Plan', description: 'Next steps' })
  expect(w.sent).toEqual([{ model: 'opus', effort: 'high' }])
  expect((await pane($)).reasons[0]).toMatch(/\[floored from read by the agent type\]/)
})

test('a fork and a custom type are not decided by the mod: no model is asked, the named pair is not sent on', KEY, async ($, on) => {
  const w = wire(on, { fm: [fmSays('critical')], net: [jevSays('critical')] })
  await spawn($, { subagent_type: 'fork' })
  await spawn($, { subagent_type: 'zetetic:reviewer', model: 'sonnet' })
  expect(w.calls).toHaveLength(0)
  expect(w.nets).toHaveLength(0)
  expect(w.sent).toEqual([{ model: undefined, effort: undefined }, { model: undefined, effort: undefined }]) // `sonnet` was only asked
})

test('the section tells the main loop that the mod decides and how a refusal is answered', async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))
  const out = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
  const text = out.sections.at(-1)?.text ?? ''
  expect(text).toMatch(/decides each subagent's model and effort/)
  expect(text).toMatch(/recorded as a request/)
  expect(text).toMatch(/call AskUserQuestion with exactly those/)
})
