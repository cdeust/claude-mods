import { expect, test } from 'claude-code/testing'

import type { OutcomeEvent, TurnRecord } from '../types'
import { delegationStats } from './delegations'
import { combineOutcomes, eventsBySession, eventsOf, judge } from './outcome'

let clock = 0
const ev = (kind: OutcomeEvent['kind'], rest: Partial<OutcomeEvent> = {}): OutcomeEvent => ({ at: ++clock, kind, src: 'command', ok: true, ...rest })
const commit = (sha: string, agent?: string, label?: string) => ev('commit', { sha, ...(agent === undefined ? {} : { agent }), ...(label === undefined ? {} : { label }) })
const create = (pr: string, agent?: string) => ev('pr-create', { pr, ...(agent === undefined ? {} : { agent }) })
const verdict = (pr: string, v: 'approve' | 'changes', head?: string) => ev('verdict', { pr, verdict: v, ...(head === undefined ? {} : { head }) })
const merge = (pr: string) => ev('pr-merge', { pr })
const test_ = (label: string, ok: boolean | null, agent?: string) => ev('test', { label, ok, ...(agent === undefined ? {} : { agent }) })

test('achieved: the delegation PR is merged and the last verdict is an APPROVE on its head', () => {
  const events = [commit('aaaaaaa1', 'A'), create('o/r#1', 'A'), verdict('o/r#1', 'approve', 'aaaaaaa1'), merge('#1')]
  expect(judge(events, 'A')).toMatchObject({ verdict: 'achieved', reason: 'merged-approved', rounds: 0, commits: 1 })
})

test('REQUEST-CHANGES rounds are counted; fixed, approved on the new head and merged is still achieved', () => {
  const events = [
    commit('aaaaaaa1', 'A'),
    create('o/r#1', 'A'),
    verdict('o/r#1', 'changes', 'aaaaaaa1'),
    commit('bbbbbbb2', 'A'),
    verdict('o/r#1', 'changes', 'bbbbbbb2'),
    commit('ccccccc3', 'A'),
    verdict('o/r#1', 'approve', 'ccccccc3'),
    merge('o/r#1'),
  ]
  expect(judge(events, 'A')).toMatchObject({ verdict: 'achieved', rounds: 2, commits: 3 })
})

test('an APPROVE on an older head is stale: merged, but not credited', () => {
  const events = [commit('aaaaaaa1', 'A'), create('#1', 'A'), verdict('#1', 'approve', 'aaaaaaa1'), commit('bbbbbbb2', 'A'), merge('#1')]
  expect(judge(events, 'A')).toMatchObject({ verdict: 'unclear', reason: 'approve-stale' })
})

test('not achieved: a closed PR, a reverted commit', () => {
  expect(judge([commit('aaaaaaa1', 'A'), create('#1', 'A'), ev('pr-close', { pr: '#1' })], 'A')).toMatchObject({ verdict: 'not-achieved', reason: 'closed' })
  const reverted = [commit('aaaaaaa1', 'A'), create('#1', 'A'), verdict('#1', 'approve', 'aaaaaaa1'), merge('#1'), ev('revert', { sha: 'aaaaaaa' })]
  expect(judge(reverted, 'A')).toMatchObject({ verdict: 'not-achieved', reason: 'reverted', reverted: 1 })
})

test('a revert of HEAD reaches the latest commit before it, whoever made it; a reset HEAD~n only possibly discards', () => {
  expect(judge([commit('aaaaaaa1', 'A'), ev('revert', { sha: 'head' })], 'A')).toMatchObject({ reverted: 1 })
  const reset = judge([commit('aaaaaaa1', 'A'), commit('bbbbbbb2', 'A'), ev('reset', { sha: 'head~1', back: 1 })], 'A')
  expect(reset).toMatchObject({ reverted: 0, possiblyDiscarded: 1, verdict: 'unclear' })
})

test('an amend replaces the actor latest commit without penalty', () => {
  const events = [commit('aaaaaaa1', 'A'), commit('bbbbbbb2', 'A', 'amended')]
  expect(judge(events, 'A')).toMatchObject({ commits: 1, reverted: 0 })
})

test('a delegation is judged on its own events only; another agent PR does not credit it', () => {
  const events = [commit('aaaaaaa1', 'A'), create('#1', 'A'), commit('bbbbbbb2', 'B'), create('#2', 'B'), verdict('#2', 'approve', 'bbbbbbb2'), merge('#2')]
  expect(judge(events, 'B').verdict).toBe('achieved')
  expect(judge(events, 'A').verdict).toBe('unclear')
})

test('a verdict that cites the delegation commit credits it even when the main thread opened the PR', () => {
  const events = [commit('aaaaaaa1', 'A'), create('#5'), verdict('#5', 'approve', 'aaaaaaa'), merge('#5')]
  expect(judge(events, 'A')).toMatchObject({ verdict: 'achieved' })
})

test('a session: verified work = a commit and a green run after it; a final red run is not achieved; an unreadable run says nothing', () => {
  expect(judge([commit('aaaaaaa1'), test_('pytest', true)], null)).toMatchObject({ verdict: 'achieved', reason: 'verified', testsPassed: 1 })
  expect(judge([test_('pytest', true), commit('aaaaaaa1')], null).verdict).toBe('unclear')
  expect(judge([commit('aaaaaaa1'), test_('pytest', false), test_('bun test', true)], null)).toMatchObject({ verdict: 'not-achieved', reason: 'tests-red', testsFailed: 1 })
  expect(judge([commit('aaaaaaa1'), test_('pytest', false), test_('pytest', true)], null).verdict).toBe('achieved')
  expect(judge([commit('aaaaaaa1'), test_('claude plugin test', null)], null).verdict).toBe('unclear')
  expect(judge([], null)).toMatchObject({ verdict: 'unclear', reason: 'no-signal' })
})

test('events carry n: a folded failing run counts all its repeats', () => {
  expect(judge([commit('aaaaaaa1'), { ...test_('bun test', false), n: 4 }], null)).toMatchObject({ testsFailed: 4 })
})

const record = (session: string, events: OutcomeEvent[], agents: TurnRecord['agents'] = []): TurnRecord => ({
  session,
  turnId: `t-${session}-${events[0]?.at ?? 0}`,
  at: events[0]?.at ?? 0,
  taskClass: null,
  main: [{ phase: 'implementation', effort: 'low', steps: 3, errors: 0 }],
  agents,
  advisor: { calls: 0, beforeWrite: 0, atCompletion: 0 },
  stuck: 0,
  events,
})

test('eventsOf joins a session records in time order', () => {
  const a = record('s', [ev('commit', { sha: '1111111' })])
  const b = record('s', [ev('push')])
  expect(eventsOf([b, a]).map((e) => e.kind)).toEqual(['commit', 'push'])
})

test('events decide a session outcome, facets fill the gaps, and a disagreement is counted with the events standing', () => {
  const merged = [commit('aaaaaaa1'), create('#1'), verdict('#1', 'approve', 'aaaaaaa1'), merge('#1')]
  const records = [record('ev', merged), record('only-facet', []), record('both-agree', merged), record('both-differ', merged), record('none', [])]
  const facets = new Map<string, 'achieved' | 'not-achieved' | 'unclear'>([
    ['only-facet', 'not-achieved'],
    ['both-agree', 'achieved'],
    ['both-differ', 'not-achieved'],
  ])
  const { outcomes, sources } = combineOutcomes(records, facets)
  expect([...outcomes]).toEqual([
    ['ev', 'achieved'],
    ['only-facet', 'not-achieved'],
    ['both-agree', 'achieved'],
    ['both-differ', 'achieved'],
  ])
  expect(sources).toEqual({ events: 1, facets: 1, both: 2, disagree: 1, unclear: 1 })
})

test('delegationStats carries each delegation outcome from its session events', () => {
  const design = { model: 'opus', effort: 'high', shape: null }
  const agent = (agentId: string) => ({ agentId, type: 'engineer', phase: 'implementation' as const, model: 'claude-sonnet-5-5', steps: 9, errors: 0, design })
  const events = [commit('aaaaaaa1', 'A'), create('#1', 'A'), verdict('#1', 'changes'), commit('bbbbbbb2', 'A'), verdict('#1', 'approve', 'bbbbbbb2'), merge('#1'), commit('ccccccc3', 'B'), create('#2', 'B'), ev('pr-close', { pr: '#2' })]
  const stats = delegationStats([record('s', events, [agent('A'), agent('B'), agent('C')])])
  expect(stats.outcomes).toEqual({ achieved: 1, 'not-achieved': 1, unclear: 1 })
  expect(stats.rounds).toBe(1)
})

test('a pull request named in full by one call and by number by another is one PR: its rounds are counted once', () => {
  const events = [commit('aaaaaaa1', 'A'), create('o/r#24', 'A'), verdict('#24', 'changes', 'aaaaaaa1'), commit('bbbbbbb2', 'A'), verdict('#24', 'approve', 'bbbbbbb2'), merge('#24')]
  expect(judge(events, 'A')).toMatchObject({ verdict: 'achieved', rounds: 1 })
  expect(judge(events, null)).toMatchObject({ rounds: 1 })
})

test('a merge after REQUEST-CHANGES with no later APPROVE is unclear: merged, but not reviewed good and not changes-requested', () => {
  const events = [commit('aaaaaaa1', 'A'), create('o/r#1', 'A'), verdict('o/r#1', 'changes', 'aaaaaaa1'), merge('o/r#1')]
  expect(judge(events, 'A')).toMatchObject({ verdict: 'unclear', reason: 'merged-unapproved', rounds: 1 })
  expect(judge(events, null)).toMatchObject({ verdict: 'unclear', reason: 'merged-unapproved' })
})

test('a merged PR with no verdict is not pending: the events say nothing of its review', () => {
  expect(judge([commit('aaaaaaa1', 'A'), create('#1', 'A'), merge('#1')], 'A')).toMatchObject({ verdict: 'unclear', reason: 'no-signal' })
})

test('a merge whose call could not be read (ok null) is no merge', () => {
  const events = [commit('aaaaaaa1', 'A'), create('#1', 'A'), verdict('#1', 'approve', 'aaaaaaa1'), { ...merge('#1'), ok: null }]
  expect(judge(events, 'A')).toMatchObject({ verdict: 'unclear', reason: 'pending' })
})

test('an unmerged PR still open is pending (unclear): REQUEST-CHANGES or no verdict, even with a red run', () => {
  expect(judge([commit('aaaaaaa1', 'A'), create('#1', 'A'), verdict('#1', 'changes')], 'A')).toMatchObject({ verdict: 'unclear', reason: 'pending', rounds: 1 })
  expect(judge([commit('aaaaaaa1', 'A'), create('#1', 'A')], 'A')).toMatchObject({ verdict: 'unclear', reason: 'pending' })
  expect(judge([commit('aaaaaaa1', 'A'), create('#1', 'A'), test_('pytest', false, 'A')], 'A')).toMatchObject({ verdict: 'unclear', reason: 'pending' })
  expect(judge([commit('aaaaaaa1'), create('#1'), verdict('#1', 'changes')], null)).toMatchObject({ verdict: 'unclear', reason: 'pending' })
})

const design = { model: 'opus', effort: 'high', shape: null }
const agent = (agentId: string) => ({ agentId, type: 'engineer', phase: 'implementation' as const, model: 'claude-sonnet-5-5', steps: 9, errors: 0, design })

test('two sessions: changes in the first, fix + APPROVE + merge in the second; the first is not a false negative', () => {
  const s1 = record('s1', [commit('aaaaaaa1', 'A'), create('o/r#24', 'A'), verdict('o/r#24', 'changes', 'aaaaaaa1')], [agent('A')])
  const s2 = record('s2', [commit('bbbbbbb2', 'B'), verdict('o/r#24', 'approve', 'bbbbbbb2'), merge('#24')], [agent('B')])
  expect(delegationStats([s1, s2]).outcomes).toEqual({ achieved: 1, 'not-achieved': 0, unclear: 1 })
  const { outcomes } = combineOutcomes([s1, s2], new Map())
  expect(outcomes.get('s1')).toBeUndefined()
  expect(outcomes.get('s2')).toBe('achieved')
  expect(delegationStats([s1]).outcomes).toEqual({ achieved: 0, 'not-achieved': 0, unclear: 1 })
})

test('two sessions: the same agent PR merged in a later session after an APPROVE of its own head is achieved', () => {
  const s1 = record('s1', [commit('aaaaaaa1', 'A'), create('o/r#24', 'A'), verdict('o/r#24', 'changes', 'aaaaaaa1'), commit('bbbbbbb2', 'A')], [agent('A')])
  const s2 = record('s2', [verdict('o/r#24', 'approve', 'bbbbbbb2'), merge('o/r#24')])
  expect(delegationStats([s1, s2]).outcomes).toEqual({ achieved: 1, 'not-achieved': 0, unclear: 0 })
  expect(combineOutcomes([s1, s2], new Map()).outcomes.get('s1')).toBe('achieved')
})

test('two sessions: a number without a repository joins nothing across sessions; another PR of that number is not this one', () => {
  const s1 = record('s1', [commit('aaaaaaa1', 'A'), create('o/r#24', 'A'), verdict('o/r#24', 'changes', 'aaaaaaa1')], [agent('A')])
  const s2 = record('s2', [verdict('#24', 'approve', 'aaaaaaa1'), merge('#24')])
  expect(delegationStats([s1, s2]).outcomes).toEqual({ achieved: 0, 'not-achieved': 0, unclear: 1 })
  expect(judge(eventsOf([s1]), 'A').reason).toBe('pending')
  expect(combineOutcomes([s1, s2], new Map()).outcomes.get('s1')).toBeUndefined()
})

test('two sessions: a bare #N in both sessions is not known to be one PR, so nothing joins', () => {
  const s1 = record('s1', [commit('aaaaaaa1', 'A'), create('#24', 'A'), verdict('#24', 'changes', 'aaaaaaa1')], [agent('A')])
  const s2 = record('s2', [merge('#24')])
  expect(delegationStats([s1, s2]).outcomes).toEqual({ achieved: 0, 'not-achieved': 0, unclear: 1 })
  expect(judge(eventsBySession([s1, s2]).get('s1')!.own, 'A', eventsBySession([s1, s2]).get('s1')!.foreign).reason).toBe('pending')
})

test('two sessions: a PR closed in a later session makes the first session not achieved', () => {
  const s1 = record('s1', [commit('aaaaaaa1', 'A'), create('o/r#24', 'A')], [agent('A')])
  const s2 = record('s2', [ev('pr-close', { pr: 'o/r#24' })])
  expect(delegationStats([s1, s2]).outcomes).toEqual({ achieved: 0, 'not-achieved': 1, unclear: 0 })
})

test('two sessions: the foreign merge of PR #25 is not credited to PR #24 of a session that names both', () => {
  const s1 = record('s1', [commit('aaaaaaa1', 'A'), create('o/r#24', 'A'), verdict('o/r#24', 'approve', 'aaaaaaa1'), create('o/r#25', 'A')], [agent('A')])
  const s2 = record('s2', [merge('o/r#25')])
  const joined = eventsBySession([s1, s2]).get('s1')!
  expect(joined.foreign.map((e) => e.pr)).toEqual(['o/r#25'])
  expect(judge(joined.own, 'A', joined.foreign)).toMatchObject({ verdict: 'unclear', reason: 'pending' })
  expect(delegationStats([s1, s2]).outcomes).toEqual({ achieved: 0, 'not-achieved': 0, unclear: 1 })
  const s3 = record('s3', [merge('o/r#24')])
  expect(delegationStats([s1, s3]).outcomes).toEqual({ achieved: 1, 'not-achieved': 0, unclear: 0 })
})
