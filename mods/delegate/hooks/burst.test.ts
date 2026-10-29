import { expect, test } from 'claude-code/testing'

import { fmSays, jevSays, pane, spawn } from './stub'
import type { Call, Dollar, On } from './stub'

// Every `process.run` waits until the test releases it, so concurrent spawns and the warm-up can be ordered.
function held(on: On) {
  const calls: Call[] = []
  const waiting: Array<{ n: number; go: () => void }> = []
  const releases: Array<(value: object) => void> = []
  on('process.run', (_, e) => {
    calls.push({ argv: e.argv, stdin: e.init?.stdin, timeoutMs: e.init?.timeoutMs })
    for (const w of waiting.filter((x) => x.n <= calls.length)) w.go()
    return new Promise((resolve) => releases.push((value) => resolve({ value } as never)))
  })
  const sent: Array<{ model?: string; effort?: string }> = []
  on('tool.call', (_, e) => {
    if (e.tool === 'Agent') sent.push({ model: e.model, effort: e.effort })
    if (e.tool === 'AskUserQuestion') return { deny: 'no one to ask' }
    return { result: {} }
  })
  const sleeps: Array<() => void> = []
  on('clock.sleep', () => new Promise((resolve) => sleeps.push(() => resolve({ value: undefined as never }))))
  on('ui.log', () => ({ value: undefined as never }))
  const fetches: string[] = []
  on('http.fetch', (_, e) => {
    fetches.push(e.url)
    const r = jevSays('read', 0.6)
    return r instanceof Error ? { deny: r.message } : { value: { ok: true, headers: {}, ...r } }
  })
  const done = (r: ReturnType<typeof fmSays>) => ({ stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...(r as object) })
  return {
    calls,
    sent,
    fetches,
    fire: () => sleeps.splice(0).forEach((f) => f()),
    arrived: (n: number) => (calls.length >= n ? Promise.resolve() : new Promise<void>((go) => waiting.push({ n, go }))),
    release: (i: number, r: ReturnType<typeof fmSays>) => releases[i]?.(done(r)),
  }
}

const KEY = { options: { typesafe_api_key: 'tsk-secret-value' } }
const start = async ($: Dollar, on: On) => {
  on('session.start', () => ({ cwd: '/' }))
  on('command.register', () => ({ value: undefined as never }))
  on('ui.open', () => ({ value: undefined as never }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
}

test('a burst: the first two reach fm, the third is fm-busy at once and, with no key, goes to the user', async ($, on) => {
  const h = held(on)
  const a = spawn($, { description: 'Fix A' })
  const b = spawn($, { description: 'Fix B' })
  const c = (await spawn($, { description: 'Fix C' })) as { deny?: string }
  expect(c.deny).toMatch(/AskUserQuestion/) // not queued, not guessed
  expect(h.calls).toHaveLength(1) // A only; B waits behind it

  h.release(0, fmSays('build'))
  await h.arrived(2) // B's call starts only once A is done
  h.release(1, fmSays('judge'))
  await Promise.all([a, b])
  expect(h.sent).toEqual([{ model: 'sonnet', effort: 'medium' }, { model: 'opus', effort: 'high' }])

  const { lines, reasons } = await pane($)
  expect(lines.map((l) => l.match(/\[(\w+)\]/)?.[1]).sort()).toEqual(['fm', 'fm', 'none'])
  expect(reasons.some((r) => /fm: fm-busy; jev: jev-nokey/.test(r))).toBe(true)
})

test('a burst with a key: the spawn fm cannot serve in time is decided by Jev alone, the others by both', KEY, async ($, on) => {
  const h = held(on)
  const a = spawn($, { description: 'Fix A' })
  const b = spawn($, { description: 'Fix B' })
  await spawn($, { description: 'Fix C' }) // fm-busy: Jev answers
  h.release(0, fmSays('read'))
  await h.arrived(2)
  h.release(1, fmSays('read'))
  await Promise.all([a, b])
  expect(h.fetches).toHaveLength(3) // Jev saw all three
  const { lines } = await pane($)
  expect(lines.map((l) => l.match(/\[([\w+]+)\]/)?.[1]).sort()).toEqual(['fm+jev', 'fm+jev', 'jev'])
})

test('while the model warms up a spawn is fm-busy and does not wait behind the warm-up', async ($, on) => {
  const h = held(on)
  await start($, on)
  await h.arrived(1)
  expect(h.calls[0]?.argv.slice(0, 5)).toEqual(['/usr/bin/fm', 'respond', '--no-stream', '--greedy', 'ok'])
  expect(h.calls[0]?.timeoutMs).toBe(30000)

  const r = (await spawn($, { description: 'Crawl the docs' })) as { deny?: string }
  expect(h.calls).toHaveLength(1) // no classification call was made behind the warm-up
  expect(r.deny).toMatch(/AskUserQuestion/)
  expect((await pane($)).reasons[0]).toMatch(/fm: fm-busy/)
})

test('while the model warms up, Jev takes the spawn', KEY, async ($, on) => {
  const h = held(on)
  await start($, on)
  await h.arrived(1)
  await spawn($, { description: 'Crawl the docs' })
  expect(h.sent).toEqual([{ model: 'haiku', effort: 'low' }])
  expect((await pane($)).lines[0]).toMatch(/\[jev\]/)
})

test('a warm-up that never returns is ended by its guard: the model is not warming for the rest of the session', async ($, on) => {
  const h = held(on)
  await start($, on)
  await h.arrived(1)
  expect(((await spawn($, { description: 'Crawl the docs' })) as { deny?: string }).deny).toMatch(/AskUserQuestion/)
  expect(h.calls).toHaveLength(1) // busy: no classification call
  h.fire() // the warm-up's guard runs out; the process was never answered
  for (let i = 0; i < 20; i++) await Promise.resolve() // the continuations of the settled guard
  const a = spawn($, { description: 'Crawl the docs again' })
  await h.arrived(2) // now a classification call reaches fm
  h.release(1, fmSays('read'))
  await a
  expect(h.sent).toEqual([{ model: 'haiku', effort: 'low' }])
})
