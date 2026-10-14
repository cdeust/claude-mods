import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { INSIGHTS, PHASES } from './fixture'

// The pane through the engine: it validates on every surface, draws a Raster in the terminal by
// default, pixel Images when the option asks, and words elsewhere.

const PANE = {
  component: 'Pane',
  requestId: 'mission-control',
  props: { title: 'Mission', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const deps = (on: Parameters<TestBody>[1]) => {
  mock.clock(on, { now: 100_000 })
  on('session.start', () => ({ cwd: '/r' }))
  on('env.get', () => ({ value: undefined as never }))
  on('state.get', ($$, e, next) => {
    const { plugin, key } = e as { plugin?: string; key?: string }
    if (plugin === 'zetetic-autopilot' && key === 'phases') return { value: { value: PHASES as never, version: 1 } }
    if (plugin === 'zetetic-insights') return { value: { value: INSIGHTS as never, version: 1 } }
    return next(e)
  })
}

test('cells by default: one Raster in the terminal, words on the other surfaces', async ($, on) => {
  deps(on)
  const term = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE })
  expect(await term.find({ key: 'mission' })).toBeDefined()
  await term.unmount()
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'mission-control', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /^main: analysis high 6 steps/ })).toBeDefined()
    await ui.unmount()
  }
})

test('pixels when the option asks: Images for the lanes and each curve, text around them', { options: { renderer: 'pixels' } }, async ($, on) => {
  deps(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  const ui = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE })
  expect(await ui.find({ key: 'lanes' })).toBeDefined()
  expect(await ui.find({ key: 'curve-test' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^EFFORT$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^STEPS BY MODEL/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^DELEGATIONS/ })).toBeDefined()
  await ui.unmount()
})

test('pixels at the widest and the narrowest pane stay inside the Image bounds', { options: { renderer: 'pixels' } }, async ($, on) => {
  deps(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  for (const bodyColumns of [300, 20]) {
    const ui = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns } })
    const lanes = (await ui.find({ key: 'lanes' })) as { props: { columns: number; source: { width: number } } } | undefined
    const curve = (await ui.find({ key: 'curve-test' })) as { props: { columns: number; source: { width: number } } } | undefined
    for (const img of [lanes, curve]) {
      expect(img!.props.columns >= 1 && img!.props.columns <= 255).toBe(true)
      expect(img!.props.source.width >= 1 && img!.props.source.width <= 2048).toBe(true)
    }
    await ui.unmount()
  }
})

test('/mission opens the pane and says which renderer and why', { options: { renderer: 'cells' } }, async ($, on) => {
  deps(on)
  on('command.register', () => ({ value: undefined as never }))
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  const r = await $.command.run({ command: 'mission' } as never)
  expect(r.text).toBe('Mission control opened; drawn in cells (set in the renderer option).')
})

test("main's turn is kept when it completes, an agent's is not", async ($, on) => {
  deps(on)
  on('turn.complete', () => ({ text: '' }))
  let kept: { turnId: string; model: string }[] = []
  on('state.set', ($$, e, next) => {
    if ((e as { key?: string }).key === 'history') kept = (e as unknown as { value: typeof kept }).value
    return next(e)
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.turn.complete({ turnId: 'g1', reason: 'answer', agentId: 'a1' } as never)
  expect(kept).toEqual([])
  await $.turn.complete({ turnId: 'turn-0001-abcd', reason: 'answer' } as never)
  expect(kept.map((t) => t.turnId)).toEqual(['turn-0001-abcd'])
  expect(kept[0]!.model).toBe('claude-opus-5-5')
})
