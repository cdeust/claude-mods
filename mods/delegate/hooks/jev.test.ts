import { expect, test } from 'claude-code/testing'

import type { Sleep } from './fm'
import { jev, parse, request } from './jev'
import type { Fetch } from './jev'

const never: Sleep = () => new Promise<void>(() => undefined)
const task = { description: 'Review it', subagent_type: 'general-purpose', prompt: 'p' }
const reply = (status: number, text: string): Fetch => async () => ({ status, text })
const ok = JSON.stringify({ answers: { route: { choice: 'judge', confidence: 0.8, probabilities: { judge: 0.8 } } } })

test('the request is a Choice question over the four classes, the brief is the state', () => {
  const body = JSON.parse(request(task))
  expect(body.model).toBe('jev-latest')
  expect(body.state).toBe('<brief>\ndescription: Review it\nsubagent_type: general-purpose\nprompt: p\n</brief>')
  expect(body.questions.route.type).toBe('choice')
  expect(Object.keys(body.questions.route.criteria)).toEqual(['read', 'build', 'judge', 'critical'])
})

test('an answer parses to a class and a confidence; anything else does not', () => {
  expect(parse(ok)).toEqual({ cls: 'judge', confidence: 0.8 })
  expect(parse('{"answers":{"route":{"choice":"judge"}}}')).toEqual({ cls: 'judge', confidence: 0 })
  expect(parse('{"answers":{"route":{"choice":"bogus","confidence":1}}}')).toBeNull()
  expect(parse('{"answers":{}}')).toBeNull()
  expect(parse('[')).toBeNull()
})

test('no key: nothing is sent', async () => {
  let sent = 0
  const f: Fetch = async () => {
    sent++
    return { status: 200, text: ok }
  }
  expect(await jev(f, never, '', task)).toEqual({ ok: false, failure: 'jev-nokey' })
  expect(sent).toBe(0)
})

test('the key rides in the authorization header only', async () => {
  let seen: Parameters<Fetch>[1] | undefined
  const f: Fetch = async (_, init) => {
    seen = init
    return { status: 200, text: ok }
  }
  expect(await jev(f, never, 'k-123', task)).toEqual({ ok: true, cls: 'judge', confidence: 0.8 })
  expect(seen?.headers.authorization).toBe('Bearer k-123')
  expect(seen?.body).not.toContain('k-123')
})

test('429 and 529 are limits, 401 and 403 are auth, other statuses are http: one request, never a retry', async () => {
  let n = 0
  const count = (status: number): Fetch => async () => {
    n++
    return { status, text: '{}' }
  }
  expect(await jev(count(429), never, 'k', task)).toEqual({ ok: false, failure: 'jev-limited', status: 429 })
  expect(await jev(count(529), never, 'k', task)).toEqual({ ok: false, failure: 'jev-limited', status: 529 })
  expect(await jev(count(403), never, 'k', task)).toEqual({ ok: false, failure: 'jev-auth', status: 403 })
  expect(await jev(count(401), never, 'k', task)).toEqual({ ok: false, failure: 'jev-auth', status: 401 })
  expect(await jev(count(500), never, 'k', task)).toEqual({ ok: false, failure: 'jev-http', status: 500 })
  expect(n).toBe(5)
})

test('bad output and a failed request keep neither the body nor the error', async () => {
  expect(await jev(reply(200, 'nope'), never, 'k', task)).toEqual({ ok: false, failure: 'jev-unparseable' })
  const boom: Fetch = async () => {
    throw new Error('connect failed for Bearer k')
  }
  expect(await jev(boom, never, 'k', task)).toEqual({ ok: false, failure: 'jev-error' })
})

test('a request that never answers is cut by the guard', async () => {
  let fire: () => void = () => undefined
  const sleep: Sleep = () => new Promise<void>((r) => {
    fire = r
  })
  const hung: Fetch = () => new Promise(() => undefined)
  const p = jev(hung, sleep, 'k', task)
  fire()
  expect(await p).toEqual({ ok: false, failure: 'jev-timeout' })
})
