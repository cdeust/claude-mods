import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Wiring: a main turn's runs go to the ledger, the evidence becomes a proposal, /calibrate apply
// writes the file the autopilot reads; enforced, the file is written at once.

const CAL = '/home/t/.claude/zetetic-insights/calibration.json'

type World = { files: Record<string, string>; written: Record<string, string>; store: Record<string, unknown> }

// A main turn of 40 test steps at medium, 12 of them with a failed call: enough to raise.
const PHASES = {
  turnId: 't1',
  loops: [
    {
      id: 'main',
      type: 'main',
      description: 'main loop',
      model: 'claude-opus-5-5',
      effort: 'medium',
      phase: 'test',
      runs: [{ phase: 'test', effort: 'medium', steps: 40, errors: 12, since: 5 }],
      status: 'running',
      advisorCalls: 0,
      wrote: true,
      updatedAt: 6,
    },
  ],
  advisor: { session: 0, uses: [] },
}

const stubs = (on: Parameters<TestBody>[1], w: World) => {
  mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/r' }))
  on('session.cwd', () => ({ value: '/r' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('env.get', ($, e) => ({ value: ((e as { name?: string }).name === 'HOME' ? '/home/t' : undefined) as never }))
  on('fs.exists', ($, e) => ({ value: String((e as { path?: string }).path) in w.files }))
  on('fs.read', ($, e) => {
    const text = w.files[String((e as { path?: string }).path)]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', ($, e) => {
    const { path, text } = e as unknown as { path: string; text: string }
    w.written[path] = text
    w.files[path] = text
    return { value: undefined as never }
  })
  on('store.get', ($, e) => ({ value: w.store[String((e as { key?: string }).key)] as never }))
  on('store.set', ($, e) => {
    const { key, value } = e as unknown as { key: string; value: unknown }
    w.store[key] = value
    return { value: undefined as never }
  })
  on('command.register', () => ({ value: undefined as never }))
  on('state.get', ($, e, next) => {
    const plugin = (e as { plugin?: string }).plugin
    if (plugin === 'zetetic-autopilot')
      return { value: { value: ((e as { key?: string }).key === 'phases' ? PHASES : { decisions: [] }) as never, version: 1 } }
    if (plugin === 'zetetic-genius') return { value: { value: { classified: { turnId: 't1', taskClass: 'bugfix' } } as never, version: 1 } }
    return next(e)
  })
  on('turn.complete', () => ({ text: '' }))
}

test('observe: a main turn is kept in the ledger and its evidence proposed, not applied', async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  const ledger = w.store.turns as { session: string; taskClass: string; main: unknown[] }[]
  expect(ledger.length).toBe(1)
  expect(ledger[0]?.session).toBe('sess-1')
  expect(ledger[0]?.taskClass).toBe('bugfix')
  expect(w.written[CAL]).toBe(undefined)
  const shown = await $.command.run({ command: 'calibrate' } as never)
  expect(shown.text).toMatch(/^Ledger: 1 turns over 1 sessions, 0 judged by \/insights\./)
  expect(shown.text).toMatch(/Proposals: test medium → high \(12 failed calls in 40 steps at medium over 1 sessions\)/)
  const done = await $.command.run({ command: 'calibrate', args: 'apply' } as never)
  expect(done.text).toBe('Applied: test medium → high.')
  expect(JSON.parse(w.written[CAL] ?? '{}').phases).toEqual({ test: 'high' })
})

test('enforce: the proposal is written to the calibration file as soon as it is made', { options: { learning_mode: 'enforce' } }, async ($, on) => {
  const w: World = { files: {}, written: {}, store: {} }
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  expect(JSON.parse(w.written[CAL] ?? '{}').phases).toEqual({ test: 'high' })
})

test('a calibration file that is not the expected shape is named, not read as empty', async ($, on) => {
  const w: World = { files: { [CAL]: '{"phases":{}}' }, written: {}, store: {} }
  stubs(on, w)
  let state: { calibrationError?: string | null } = {}
  on('state.set', ($, e, next) => {
    if ((e as { key?: string }).key === 'insights') state = (e as unknown as { value: typeof state }).value
    return next(e)
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  expect(state.calibrationError).toMatch(/not version 1/)
})
