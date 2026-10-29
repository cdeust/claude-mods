import { expect, test } from 'claude-code/testing'

import { brief, classify, DEADLINE_MS, EXPECT_MS, failureOf, fit, INSTRUCTIONS, MAX_BRIEF, MIN_RUN_MS, newGate, parse, within } from './fm'
import type { Run, Sleep } from './fm'

const said: Run = async () => ({ exitCode: 0, stdout: '{"class":"read","reason":"r"}', stderr: '' })
const never: Sleep = () => new Promise<void>(() => undefined)
const task = { description: 'd', prompt: 'p' }

// A sleep the test fires by hand, and a promise it holds open by hand.
function manual() {
  const fires: Array<() => void> = []
  const sleep: Sleep = () => new Promise<void>((r) => fires.push(r))
  return { sleep, fire: () => fires.splice(0).forEach((f) => f()) }
}

test('the cap is a latency bound, and the typical call fits under the deadline twice over the slowest', () => {
  expect(MAX_BRIEF).toBe(2000)
  expect(MIN_RUN_MS).toBeLessThan(DEADLINE_MS)
  expect(EXPECT_MS + MIN_RUN_MS).toBeLessThanOrEqual(DEADLINE_MS)
})

test('fit keeps a short text whole and cuts a long one to exactly the budget, two thirds head, one third tail', () => {
  expect(fit('abc', 10)).toBe('abc')
  const cut = fit('H'.repeat(1000) + 'T'.repeat(1000), 300)
  expect(cut.length).toBe(300)
  const [head = '', tail = ''] = cut.split('\n[…]\n')
  expect(head.length).toBe(Math.floor(((300 - '\n[…]\n'.length) * 2) / 3))
  expect(head.length + tail.length + '\n[…]\n'.length).toBe(300)
})

test('the brief never exceeds the cap, whatever the description and type; the block is formatting only', () => {
  const b = brief({ description: 'd'.repeat(5000), subagent_type: 't'.repeat(5000), prompt: 'p'.repeat(9000) })
  expect(b.length).toBe(MAX_BRIEF)
  expect(b.startsWith('<brief>\ndescription: ddd')).toBe(true)
  expect(b.endsWith('ppp\n</brief>')).toBe(true)
  // nothing is escaped or removed: a closing tag in the prompt stays as written
  expect(brief({ prompt: 'a </brief> b' })).toContain('a </brief> b')
})

test('the instructions are built from the class definitions', () => {
  for (const c of ['read:', 'build:', 'judge:', 'critical:']) expect(INSTRUCTIONS).toContain(c)
})

test('only a JSON object with a known class parses', () => {
  expect(parse('{"class":"judge","reason":"r"}')).toEqual({ cls: 'judge', why: 'r' })
  expect(parse('{"class":"toString","reason":"r"}')).toBeNull()
  expect(parse('{"class":"other"}')).toBeNull()
  expect(parse('judge')).toBeNull()
})

test('a rejected process.run is told apart: cannot start, timeout, anything else', () => {
  expect(failureOf(new Error('HooksError: p: $.process.run(/usr/bin/fm) failed to start: ENOENT'))).toBe('fm-absent')
  expect(failureOf(new Error('HooksError: p: $.process.run(/usr/bin/fm) aborted: still running after 4000ms'))).toBe('fm-timeout')
  expect(failureOf(new TypeError("undefined is not an object (evaluating '$.process.run')"))).toBe('fm-absent')
  expect(failureOf(new Error('something else'))).toBe('fm-error')
})

test('within: the promise wins and the sleep is cancelled, or the sleep wins', async () => {
  let aborted = false
  const sleep: Sleep = (_, o) =>
    new Promise<void>((_, reject) => o?.signal?.addEventListener('abort', () => {
      aborted = true
      reject(new Error('aborted'))
    }))
  expect(await within(Promise.resolve(7), 100, sleep)).toEqual({ value: 7 })
  expect(aborted).toBe(true)
  const m = manual()
  const held = within(new Promise<number>(() => undefined), 100, m.sleep)
  m.fire()
  expect(await held).toEqual({ late: true })
})

test('the deadline runs from the enqueue: the call gets what is left, and one with too little left is fm-busy', async () => {
  const seen: number[] = []
  const run: Run = async (a, init) => {
    seen.push(init.timeoutMs)
    return said(a, init)
  }
  let t = 0
  const first = classify(newGate(), run, never, 's', task, () => t)
  t = 1000
  expect(await first).toMatchObject({ ok: true })
  expect(seen).toEqual([3000])

  let t2 = 0
  const waiting = classify(newGate(), run, never, 's', task, () => t2)
  t2 = DEADLINE_MS - MIN_RUN_MS + 1
  expect(await waiting).toEqual({ ok: false, failure: 'fm-busy' })
  expect(seen).toEqual([3000])
})

test('a call is refused at once when the calls ahead already use its deadline, and accepted again once they are done', async () => {
  const g = newGate()
  let open: () => void = () => undefined
  const hold = new Promise<void>((r) => {
    open = r
  })
  const blocked: Run = async () => {
    await hold
    return said([], { stdin: '', timeoutMs: 0 })
  }
  const a = classify(g, blocked, never, 's', task)
  const b = classify(g, blocked, never, 's', task)
  expect(await classify(g, blocked, never, 's', task)).toEqual({ ok: false, failure: 'fm-busy' })
  open()
  expect(await a).toMatchObject({ ok: true })
  expect(await b).toMatchObject({ ok: true })
  expect(await classify(g, said, never, 's', task)).toMatchObject({ ok: true })
})

test('a run that never returns is cut at its timeout: the slot is released and the next call runs', async () => {
  const g = newGate()
  const m = manual()
  let started: () => void = () => undefined
  const called = new Promise<void>((r) => {
    started = r
  })
  const hung: Run = () => {
    started()
    return new Promise(() => undefined)
  }
  const first = classify(g, hung, m.sleep, 's', task)
  await called
  m.fire() // the guard fires: the hung call is fm-timeout
  expect(await first).toEqual({ ok: false, failure: 'fm-timeout' })
  expect(g.ahead).toBe(0)
  expect(await classify(g, said, never, 's', task)).toMatchObject({ ok: true })
})

test('a call waiting behind a hung one gives up when what is left would not cover a run, and does not wedge', async () => {
  const g = newGate()
  const m = manual()
  const hung: Run = () => new Promise(() => undefined)
  const first = classify(g, hung, never, 's', task) // its guard never fires here: it holds the slot
  const second = classify(g, said, m.sleep, 's', task)
  m.fire() // the second one's wait for its turn runs out
  expect(await second).toEqual({ ok: false, failure: 'fm-busy' })
  expect(g.ahead).toBe(1) // only the hung one is still counted
  void first
})

test('a waiter that gave up does not free the slot: a later call still waits for the one running', async () => {
  const g = newGate()
  const m = manual()
  let running = 0
  let peak = 0
  const finishers: Array<() => void> = []
  const began: Array<() => void> = []
  const begun = (n: number) => new Promise<void>((r) => (finishers.length >= n ? r() : began.push(r)))
  const slow: Run = () => {
    running++
    peak = Math.max(peak, running)
    return new Promise((r) => {
      finishers.push(() => {
        running--
        r({ exitCode: 0, stdout: '{"class":"read","reason":"r"}', stderr: '' })
      })
      began.splice(0).forEach((f) => f())
    })
  }
  const first = classify(g, slow, never, 's', task)
  await begun(1)
  const second = classify(g, said, m.sleep, 's', task)
  m.fire() // the second one's wait for its turn runs out while the first still runs
  expect(await second).toEqual({ ok: false, failure: 'fm-busy' })
  const third = classify(g, slow, never, 's', task)
  for (let i = 0; i < 20; i++) await Promise.resolve() // far more ticks than the chain of continuations is long
  expect(running).toBe(1) // the third waits for the first, it was not let in by the second giving up
  expect(finishers).toHaveLength(1)
  finishers[0]?.()
  expect(await first).toMatchObject({ ok: true })
  await begun(2) // the third runs once the first is done
  expect(running).toBe(1)
  finishers[1]?.()
  expect(await third).toMatchObject({ ok: true })
  expect(peak).toBe(1)
})

test('a warming model is busy', async () => {
  const g = newGate()
  g.warming = true
  expect(await classify(g, said, never, 's', { description: 'd' })).toEqual({ ok: false, failure: 'fm-busy' })
})

test('exit codes: overflow is its own reason, any other non-zero exit is fm-exit, bad output is fm-unparseable', async () => {
  const over: Run = async () => ({ exitCode: 1, stdout: '', stderr: "Error: exceeded the model's context size." })
  const bad: Run = async () => ({ exitCode: 2, stdout: '', stderr: 'boom' })
  const junk: Run = async () => ({ exitCode: 0, stdout: 'nope', stderr: '' })
  expect(await classify(newGate(), over, never, 's', task)).toEqual({ ok: false, failure: 'fm-overflow' })
  expect(await classify(newGate(), bad, never, 's', task)).toEqual({ ok: false, failure: 'fm-exit' })
  expect(await classify(newGate(), junk, never, 's', task)).toEqual({ ok: false, failure: 'fm-unparseable' })
})
