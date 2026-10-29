import { expect, test } from 'claude-code/testing'
import { fmSays, wire } from './stub'

const PANE = {
  plugin: 'delegate',
  component: 'Pane',
  requestId: 'delegate',
  props: { title: 'Delegation', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('the pane shows a routed delegation, on every surface', async ($, on) => {
  wire(on, { fm: [fmSays('read')] })
  await $.tool.call({ tool: 'Agent', description: 'Crawl the docs', prompt: 'p' } as never)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Crawl the docs/ }))?.text).toMatch(/haiku → \? · low → \? · Crawl the docs \[fm\]/)
    await ui.unmount()
  }
})

const drain = async (stream: AsyncGenerator<unknown, unknown>) => {
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
}
const SPAWN = {
  tool_use_id: 'u1', prompt: 'p', description: 'Crawl the docs', subagentType: 'general-purpose',
  provider: { kind: 'model', model: 'm' }, parentModel: 'm', model: 'haiku',
} as never
const END = (e: { turnId: string; index: number }) =>
  ({ turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }) as never

test('the pane shows asked and ran for model and effort, and ? until a step is seen', async ($, on) => {
  wire(on, { fm: [fmSays('read')] })
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'ag-1' }))
  on('turn.step', async function* (_, e) {
    return END(e)
  })
  await $.tool.call({ tool: 'Agent', tool_use_id: 'u1', description: 'Crawl the docs', prompt: 'p' })
  await $.agent.spawn(SPAWN)

  const line = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const text = (await ui.find({ type: 'Text', text: /Crawl the docs/ }))?.text
    await ui.unmount()
    return text
  }
  expect(await line()).toMatch(/haiku → \? · low → \? · Crawl the docs/)

  // a step of another agent, and one of main, change nothing
  await drain($.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1, agentId: 'other' }))
  await drain($.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 }))
  expect(await line()).toMatch(/haiku → \? · low → \? · Crawl the docs/)

  await drain($.turn.step({ turnId: 'ta', index: 0, model: 'claude-haiku-4-5', effort: 'low', messageCount: 1, agentId: 'ag-1' }))
  expect(await line()).toMatch(/haiku → haiku · low → low · Crawl the docs/)

  // the first step only: a later one at another effort does not overwrite
  await drain($.turn.step({ turnId: 'ta', index: 1, model: 'claude-opus-5-5', effort: 'max', messageCount: 3, agentId: 'ag-1' }))
  expect(await line()).toMatch(/haiku → haiku · low → low · Crawl the docs/)
})

test('a step that comes before the spawn answers is kept for the row', async ($, on) => {
  wire(on, { fm: [fmSays('read')] })
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'ag-early' }))
  on('turn.step', async function* (_, e) {
    return END(e)
  })
  await $.tool.call({ tool: 'Agent', tool_use_id: 'u1', description: 'Crawl the docs', prompt: 'p' })
  await drain($.turn.step({ turnId: 'tb', index: 0, model: 'claude-haiku-4-5', effort: 'medium', messageCount: 1, agentId: 'ag-early' }))
  await $.agent.spawn(SPAWN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Crawl the docs/ }))?.text).toMatch(/haiku → haiku · low → medium · Crawl the docs/)
  await ui.unmount()
})

test('a step goes down to the engine as it came, with or without an effort', async ($, on) => {
  const seen: unknown[] = []
  on('turn.step', async function* (_, e) {
    seen.push(e.effort)
    return END(e)
  })
  await drain($.turn.step({ turnId: 'tz', index: 0, model: 'claude-haiku-4-5', messageCount: 1, agentId: 'ag-z' }))
  await drain($.turn.step({ turnId: 'ty', index: 0, model: 'claude-haiku-4-5', effort: 'high', messageCount: 1, agentId: 'ag-y' }))
  expect(seen).toEqual([undefined, 'high'])
})

test('an empty pane says so', async ($) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /No delegation/ }))?.text).toBe('No delegation yet.')
  await ui.unmount()
})
