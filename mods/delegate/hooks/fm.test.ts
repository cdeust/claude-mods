import { expect, test } from 'claude-code/testing'

import { brief, classify, DEADLINE_MS, EXPECT_MS, failureOf, fit, MAX_BRIEF, MIN_RUN_MS, newGate, parse } from './fm'
import type { Run } from './fm'

const ok: Run = async () => ({ exitCode: 0, stdout: '{"class":"read","reason":"r"}', stderr: '' })

test('the cap is a latency bound: at the measured slowest density it leaves room under the deadline', () => {
  // hex, ~1.14 characters per token, about 1.2 ms per token (README, measured 2026-10-29): 2000 characters ~ 2.1 s worst
  expect(MAX_BRIEF).toBe(2000)
  expect(MIN_RUN_MS).toBeLessThan(DEADLINE_MS)
  expect(MIN_RUN_MS + EXPECT_MS).toBeLessThanOrEqual(DEADLINE_MS)
})

test('fit keeps a short text whole and cuts a long one to exactly the budget, two thirds head, one third tail', () => {
  expect(fit('abc', 10)).toBe('abc')
  const text = 'H'.repeat(1000) + 'T'.repeat(1000)
  const cut = fit(text, 300)
  expect(cut.length).toBe(300)
  const [head = '', tail = ''] = cut.split('\n[…]\n')
  expect(head.length).toBe(Math.floor(((300 - '\n[…]\n'.length) * 2) / 3))
  expect(head.length + tail.length + '\n[…]\n'.length).toBe(300)
})

test('the brief never exceeds the cap, whatever the description and type', () => {
  const b = brief({ description: 'd'.repeat(5000), subagent_type: 't'.repeat(5000), prompt: 'p'.repeat(9000) })
  expect(b.length).toBe(MAX_BRIEF)
  expect(b.startsWith('<brief>\ndescription: ddd')).toBe(true)
  expect(b.endsWith('ppp\n</brief>')).toBe(true)
})

test('only a JSON object with a known class parses', () => {
  expect(parse('{"class":"judge","reason":"r"}')).toEqual({ cls: 'judge', why: 'r' })
  expect(parse('{"reason":"r","class":"critical"}')).toEqual({ cls: 'critical', why: 'r' })
  expect(parse('{"class":"toString","reason":"r"}')).toBeNull()
  expect(parse('{"class":"other"}')).toBeNull()
  expect(parse('judge')).toBeNull()
  expect(parse('')).toBeNull()
})

test('a rejected process.run is told apart: cannot start, timeout, anything else', () => {
  expect(failureOf(new Error('HooksError: p: $.process.run(/usr/bin/fm) failed to start: ENOENT'))).toBe('fm-absent')
  expect(failureOf(new Error('HooksError: p: $.process.run(/usr/bin/fm) aborted: still running after 4000ms'))).toBe('fm-timeout')
  expect(failureOf(new TypeError("undefined is not an object (evaluating '$.process.run')"))).toBe('fm-absent')
  expect(failureOf(new Error('something else'))).toBe('fm-error')
})

test('the deadline runs from the enqueue: the call gets what is left, and a call with too little left is fm-busy', async () => {
  const task = { description: 'd', prompt: 'p' }
  // the call starts 1000 ms after it was enqueued: it gets 3000 ms
  let t = 0
  const seen: number[] = []
  const slow: Run = async (_, init) => {
    seen.push(init.timeoutMs)
    return { exitCode: 0, stdout: '{"class":"read","reason":"r"}', stderr: '' }
  }
  const g = newGate()
  const first = classify(g, slow, 's', task, () => t)
  t = 1000
  expect(await first).toMatchObject({ ok: true })
  expect(seen).toEqual([3000])

  // enqueued at 0, its turn comes at 2500: 1500 ms left is under what a call needs, so it is not started
  const g2 = newGate()
  let t2 = 0
  const calls: number[] = []
  const run: Run = async (a, init) => {
    calls.push(init.timeoutMs)
    return ok(a, init)
  }
  const waiting = classify(g2, run, 's', task, () => t2)
  t2 = DEADLINE_MS - MIN_RUN_MS + 1
  expect(await waiting).toEqual({ ok: false, failure: 'fm-busy' })
  expect(calls).toEqual([])
})

test('a call is refused at once when the calls ahead already use its deadline', async () => {
  const task = { description: 'd', prompt: 'p' }
  const g = newGate()
  let open: () => void = () => undefined
  const gateOpen = new Promise<void>((r) => {
    open = r
  })
  const blocked: Run = async () => {
    await gateOpen
    return { exitCode: 0, stdout: '{"class":"read","reason":"r"}', stderr: '' }
  }
  const a = classify(g, blocked, 's', task)
  const b = classify(g, blocked, 's', task)
  expect(await classify(g, blocked, 's', task)).toEqual({ ok: false, failure: 'fm-busy' })
  open()
  expect(await a).toMatchObject({ ok: true })
  expect(await b).toMatchObject({ ok: true })
  // the queue drained: the next call is accepted again
  expect(await classify(g, ok, 's', task)).toMatchObject({ ok: true })
})

test('a warming model is busy', async () => {
  const g = newGate()
  g.warming = true
  expect(await classify(g, ok, 's', { description: 'd' })).toEqual({ ok: false, failure: 'fm-busy' })
})
