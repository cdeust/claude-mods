import { expect, test } from 'claude-code/testing'

import type { AgentRecord, RunRecord, TurnRecord } from '../types'
import { MODEL_SESSIONS, familyOf, sessionModels } from './models'

const turn = (session: string, at: number, o: { mainModel?: string; main?: RunRecord[]; agents?: AgentRecord[] }): TurnRecord => ({
  session,
  turnId: `${session}-${at}`,
  at,
  taskClass: null,
  ...(o.mainModel === undefined ? {} : { mainModel: o.mainModel }),
  main: o.main ?? [],
  agents: o.agents ?? [],
  advisor: { calls: 0, beforeWrite: 0, atCompletion: 0 },
  stuck: 0,
})

const run = (steps: number): RunRecord => ({ phase: 'implementation', effort: 'medium', steps, errors: 0 })
const agent = (model: string, steps: number): AgentRecord => ({ type: 'Explore', phase: 'analysis', model, steps, errors: 0 })

test('a model id is reduced to its family, matched case-insensitively in the order fable, opus, sonnet, haiku', () => {
  expect(familyOf('claude-opus-5-5')).toBe('opus')
  expect(familyOf('claude-haiku-5-5')).toBe('haiku')
  expect(familyOf('Claude-Sonnet-5-5')).toBe('sonnet')
  expect(familyOf('claude-fable-5-5')).toBe('fable')
  expect(familyOf('fable-opus')).toBe('fable')
  expect(familyOf('opus-sonnet')).toBe('opus')
  expect(familyOf('gpt-x')).toBe('other')
  expect(familyOf('')).toBe('unknown')
})

test('every step lands in exactly one family, and a session balances: family steps = main steps + agent steps', () => {
  const records = [
    // Session "old": a record kept before mainModel existed (unknown), then one on opus with two agents.
    turn('old', 10, { main: [run(4)], agents: [agent('claude-haiku-5-5', 2)] }),
    turn('old', 20, { mainModel: 'claude-opus-5-5', main: [run(6), run(3)], agents: [agent('claude-sonnet-5-5', 5), agent('gpt-x', 1)] }),
    // Session "new", newer, listed first: a fable turn, and a haiku agent with no step (dropped from the list).
    turn('new', 30, { mainModel: 'claude-fable-5-5', main: [run(2)], agents: [agent('claude-haiku-5-5', 0)] }),
  ]
  const out = sessionModels(records)
  expect(out).toEqual([
    {
      session: 'old',
      at: 20,
      steps: [
        { family: 'haiku', steps: 2 },
        { family: 'sonnet', steps: 5 },
        { family: 'opus', steps: 9 },
        { family: 'other', steps: 1 },
        { family: 'unknown', steps: 4 },
      ],
    },
    { session: 'new', at: 30, steps: [{ family: 'fable', steps: 2 }] },
  ])
  for (const s of out) {
    const mine = records.filter((r) => r.session === s.session)
    const mainSteps = mine.reduce((n, r) => n + r.main.reduce((m, x) => m + x.steps, 0), 0)
    const agentSteps = mine.reduce((n, r) => n + r.agents.reduce((m, a) => m + a.steps, 0), 0)
    expect(s.steps.reduce((n, f) => n + f.steps, 0)).toBe(mainSteps + agentSteps)
  }
})

test('no records gives no sessions', () => {
  expect(sessionModels([])).toEqual([])
})

test('the sessions are the last MODEL_SESSIONS by their latest record, oldest first, whatever the input order', () => {
  const count = MODEL_SESSIONS + 3
  const records = Array.from({ length: count }, (_, i) => turn(`s${i}`, i * 2, { mainModel: 'claude-opus-5-5', main: [run(1)] }))
  // The oldest session gets a later turn: its `at` is its latest record, so it is the newest session.
  records.push(turn('s0', 1000, { mainModel: 'claude-opus-5-5', main: [run(1)] }))
  const out = sessionModels([...records].reverse())
  expect(MODEL_SESSIONS).toBe(12)
  expect(out.length).toBe(MODEL_SESSIONS)
  expect(out.map((s) => s.session)).toEqual([...Array.from({ length: MODEL_SESSIONS - 1 }, (_, i) => `s${i + 4}`), 's0'])
  expect(out.every((s, i) => i === 0 || out[i - 1]!.at < s.at)).toBe(true)
  expect(out[0]).toEqual({ session: 's4', at: 8, steps: [{ family: 'opus', steps: 1 }] })
  expect(out[out.length - 1]).toEqual({ session: 's0', at: 1000, steps: [{ family: 'opus', steps: 2 }] })
})
