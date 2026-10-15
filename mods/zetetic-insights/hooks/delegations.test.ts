import { expect, test } from 'claude-code/testing'

import type { AgentRecord, TurnRecord } from '../types'
import { agentStats } from './learn'
import { DESIGN_FIELD_CAP, OVERKILL_STEPS, RECENT_FLAGGED, delegationStats, flagsOf, parseDesign } from './delegations'

const BLOCK = `DESIGN
task: in zetetic-insights, keep each delegation
check: claude plugin test . passes
model: haiku · effort: low · why: a lookup
genius shape: conservation-accounting → lavoisier: balance the books

Do the work.`

test('parseDesign reads the exact block format', () => {
  expect(parseDesign(BLOCK)).toEqual({ model: 'haiku', effort: 'low', shape: 'conservation-accounting → lavoisier: balance the books' })
})

test('parseDesign reads model and effort on their own lines too', () => {
  expect(parseDesign('intro\nDESIGN\nmodel: opus\neffort: high\n')).toEqual({ model: 'opus', effort: 'high', shape: null })
})

test('parseDesign: no block is null, a partial block has null fields, a field after the block is not read', () => {
  expect(parseDesign('')).toBeNull()
  expect(parseDesign('design\nmodel: haiku')).toBeNull()
  expect(parseDesign('DESIGN\ntask: x\nmodel: sonnet')).toEqual({ model: 'sonnet', effort: null, shape: null })
  expect(parseDesign('DESIGN\ntask: x\n\nmodel: sonnet')).toEqual({ model: null, effort: null, shape: null })
  expect(parseDesign(`DESIGN\nmodel: ${'x'.repeat(200)}`)?.model?.length).toBe(DESIGN_FIELD_CAP)
  expect(parseDesign(undefined as never)).toBeNull()
})

const agent = (o: Partial<AgentRecord>): AgentRecord => ({ type: 'Explore', phase: 'analysis', model: 'claude-sonnet-5-5', steps: 10, errors: 0, ...o })
const design = (model: string | null = null) => ({ model, effort: 'low', shape: null })

test('undesigned: a null design is flagged, an absent one (a legacy record) is not', () => {
  expect(flagsOf(agent({ design: null }))).toEqual(['undesigned'])
  expect(flagsOf(agent({}))).toEqual([])
  expect(flagsOf(agent({ design: design() }))).toEqual([])
})

test('rerouted: the designed family differs from the family that ran', () => {
  expect(flagsOf(agent({ design: design('opus'), model: 'claude-haiku-5-5' }))).toEqual(['rerouted'])
  expect(flagsOf(agent({ design: design('sonnet') }))).toEqual([])
  expect(flagsOf(agent({ design: design('inherit'), model: 'claude-haiku-5-5' }))).toEqual([])
  expect(flagsOf(agent({ design: design('opus'), model: '' }))).toEqual([])
})

test('overkill: opus or fable on a job of at most OVERKILL_STEPS steps', () => {
  expect(OVERKILL_STEPS).toBe(5)
  expect(flagsOf(agent({ model: 'claude-opus-5-5', steps: 5, design: design() }))).toEqual(['overkill'])
  expect(flagsOf(agent({ model: 'claude-fable-5-5', steps: 1, design: design() }))).toEqual(['overkill'])
  expect(flagsOf(agent({ model: 'claude-opus-5-5', steps: 6, design: design() }))).toEqual([])
  expect(flagsOf(agent({ model: 'claude-sonnet-5-5', steps: 1, design: design() }))).toEqual([])
})

test('underpowered: haiku with at least 4 steps and a failed-call rate of 0.25 or more', () => {
  const h = { model: 'claude-haiku-5-5', design: design() }
  expect(flagsOf(agent({ ...h, steps: 4, errors: 1 }))).toEqual(['underpowered'])
  expect(flagsOf(agent({ ...h, steps: 8, errors: 1 }))).toEqual([])
  expect(flagsOf(agent({ ...h, steps: 3, errors: 3 }))).toEqual([])
  expect(flagsOf(agent({ ...h, model: 'claude-sonnet-5-5', steps: 4, errors: 4 }))).toEqual([])
})

const turn = (at: number, agents: AgentRecord[]): TurnRecord => ({
  session: 's',
  turnId: `t${at}`,
  at,
  taskClass: null,
  main: [],
  agents,
  advisor: { calls: 0, beforeWrite: 0, atCompletion: 0 },
  stuck: 0,
})

test('stats count designed, undesigned and legacy agents apart, and each flag', () => {
  const s = delegationStats([
    turn(1, [agent({}), agent({ design: null }), agent({ design: design('sonnet') })]),
    turn(2, [agent({ design: design('opus'), model: 'claude-opus-5-5', steps: 2, type: 'Plan' })]),
  ])
  expect(s.total).toBe(3)
  expect(s.designed).toBe(2)
  expect(s.flags).toEqual({ overkill: 1, underpowered: 0, undesigned: 1, rerouted: 0 })
  expect(s.recent.map((r) => [r.at, r.type, r.flags])).toEqual([
    [1, 'Explore', ['undesigned']],
    [2, 'Plan', ['overkill']],
  ])
  expect(s.recent[1]).toMatchObject({ model: 'claude-opus-5-5', effort: 'low', shape: null, steps: 2, errors: 0 })
})

test('recent keeps the last RECENT_FLAGGED flagged rows, newest last', () => {
  const records = Array.from({ length: RECENT_FLAGGED + 3 }, (_, i) => turn(i, [agent({ design: null })]))
  const s = delegationStats(records)
  expect(s.flags.undesigned).toBe(RECENT_FLAGGED + 3)
  expect(s.recent.length).toBe(RECENT_FLAGGED)
  expect(s.recent[0]?.at).toBe(3)
  expect(s.recent[RECENT_FLAGGED - 1]?.at).toBe(RECENT_FLAGGED + 2)
})

test('an empty ledger gives empty stats', () => {
  expect(delegationStats([])).toEqual({ total: 0, designed: 0, outcomes: { achieved: 0, 'not-achieved': 0, unclear: 0 }, rounds: 0, flags: { overkill: 0, underpowered: 0, undesigned: 0, rerouted: 0 }, recent: [] })
})

const turnOf = (at: number, agents: AgentRecord[]): TurnRecord => ({ session: 's', turnId: `t${at}`, at, taskClass: null, main: [], agents, advisor: { calls: 0, beforeWrite: 0, atCompletion: 0 }, stuck: 0 })

test('a delegation of several turns is judged once, over its summed steps', () => {
  const opus = { model: 'claude-opus-5-5', steps: 3, agentId: 'x' }
  const s = delegationStats([turnOf(1, [agent({ ...opus, design: design('opus') })]), turnOf(2, [agent({ ...opus })])])
  expect(OVERKILL_STEPS).toBe(5)
  expect(s.total).toBe(1)
  expect(s.flags.overkill).toBe(0)
  expect(s.recent).toEqual([])
})

test('grouping takes the first design, the last model and the last record\'s time; legacy records stay separate', () => {
  const a = agent({ agentId: 'x', model: 'claude-haiku-5-5', steps: 1, design: design('opus') })
  const b = agent({ agentId: 'x', model: 'claude-opus-5-5', steps: 1 })
  const legacy = agent({ steps: 1, design: null })
  const s = delegationStats([turnOf(1, [a, legacy]), turnOf(2, [b, legacy])])
  expect(s.total).toBe(3)
  expect(s.flags.undesigned).toBe(2)
  expect(s.flags.overkill).toBe(1)
  expect(s.recent.find((r) => r.flags.includes('overkill'))).toMatchObject({ at: 2, model: 'claude-opus-5-5', steps: 2 })
})

test('agentStats: the records of a resumed agent hold per-turn steps, summed once', () => {
  const a = agent({ agentId: 'x', steps: 3 })
  const b = agent({ agentId: 'x', steps: 2 })
  expect(agentStats([turnOf(1, [a]), turnOf(2, [b])])[0]).toMatchObject({ runs: 2, steps: 5 })
})
