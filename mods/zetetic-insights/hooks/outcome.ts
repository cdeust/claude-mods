// The outcome model (docs/insights-outcome-model.md): what the outcome events of a session say about
// a delegation or about the session. Pure. The events are joined at read time over the whole session,
// not when they are written: the revert, the review verdict and the merge usually come later than
// the commit or the `gh pr create`, from another agent or the main thread.

import type { OutcomeEvent, OutcomeJudgement, OutcomeSources, TurnRecord, Verdict } from '../types'
import { samePr } from './events'

// A session's events in time order (ties keep their order of writing).
export const eventsOf = (records: readonly TurnRecord[]): OutcomeEvent[] =>
  records
    .flatMap((r) => r.events ?? [])
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.at - b.e.at || a.i - b.i)
    .map(({ e }) => e)

type Commit = { sha: string; at: number; agent: string | undefined; reverted: boolean; discarded: boolean }

const prefixed = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a)
const count = (e: OutcomeEvent): number => e.n ?? 1

// The commits the events show, each marked reverted (`git revert`), or possibly discarded (a
// `git reset HEAD~n`), in the order they were made. An amend replaces the actor's latest live commit.
const commitsOf = (events: readonly OutcomeEvent[]): Commit[] => {
  const commits: Commit[] = []
  for (const e of events) {
    if (e.kind === 'commit' && e.ok !== false && e.sha !== undefined) {
      const old = e.label === 'amended' ? [...commits].reverse().find((c) => c.agent === e.agent && !c.reverted) : undefined
      if (old !== undefined) commits.splice(commits.indexOf(old), 1) // the old one is not a failure
      commits.push({ sha: e.sha, at: e.at, agent: e.agent, reverted: false, discarded: false })
    } else if (e.kind === 'revert' && e.sha !== undefined) {
      const sha = e.sha
      const target = sha === 'head' ? [...commits].reverse().find((c) => c.at <= e.at && !c.reverted) : commits.find((c) => prefixed(c.sha, sha))
      if (target !== undefined) target.reverted = true
    } else if (e.kind === 'reset' && e.back !== undefined) {
      // `git reset HEAD~n` may have dropped the n latest live commits; with another target it is not readable which.
      for (const c of [...commits].reverse().filter((c) => c.at <= e.at && !c.reverted && !c.discarded).slice(0, e.back)) c.discarded = true
    }
  }
  return commits
}

type PrState = { rounds: number; approved: boolean; stale: boolean; closed: boolean; changes: boolean }

// What the verdicts, merges and closes say about the scope's pull requests: those it created, those whose
// verdict cites one of its commits, and (for the whole session) every one reviewed.
const prState = (events: readonly OutcomeEvent[], scope: string | null, mine: readonly Commit[]): PrState => {
  const live = mine.filter((c) => !c.reverted)
  const lastCommitAt = live.reduce((m, c) => Math.max(m, c.at), Number.NEGATIVE_INFINITY)
  const created = events.filter((e) => e.kind === 'pr-create' && e.ok !== false && e.pr !== undefined && (scope === null || e.agent === scope)).map((e) => e.pr!)
  const verdicts = events.filter((e) => e.kind === 'verdict' && e.pr !== undefined)
  const viaHead = verdicts.filter((v) => v.head !== undefined && mine.some((c) => prefixed(c.sha, v.head!))).map((v) => v.pr!)
  // One entry per pull request: the same PR is named `o/r#24` by one call and `#24` by another.
  const prs: string[] = []
  for (const pr of [...created, ...viaHead, ...(scope === null ? verdicts.map((v) => v.pr!) : [])]) if (!prs.some((q) => samePr(q, pr))) prs.push(pr)
  const st: PrState = { rounds: 0, approved: false, stale: false, closed: false, changes: false }
  for (const pr of prs) {
    const vs = verdicts.filter((v) => samePr(v.pr, pr) && v.verdict !== 'unknown')
    st.rounds += vs.filter((v) => v.verdict === 'changes').reduce((n, v) => n + count(v), 0)
    const last = vs[vs.length - 1]
    const merged = events.some((e) => e.kind === 'pr-merge' && e.ok !== false && samePr(e.pr, pr))
    if (!merged && events.some((e) => e.kind === 'pr-close' && e.ok !== false && samePr(e.pr, pr))) st.closed = true
    if (last?.verdict === 'changes' && !merged) st.changes = true
    if (last?.verdict !== 'approve' || !merged) continue
    const headOk = last.head === undefined || live.length === 0 || live.some((c) => prefixed(c.sha, last.head!))
    if (last.at >= lastCommitAt && headOk) st.approved = true
    else st.stale = true
  }
  return st
}

type TestState = { red: boolean; green: boolean; passed: number; failed: number }

// The test runs of the scope that could be read: red when the final run of some label failed, green
// when a label's final run passed after the last commit.
const testState = (events: readonly OutcomeEvent[], scope: string | null, lastCommitAt: number): TestState => {
  const tests = events.filter((e) => e.kind === 'test' && (scope === null || e.agent === scope) && e.ok !== null && e.ok !== undefined)
  const finalByLabel = new Map<string, OutcomeEvent>()
  for (const t of tests) finalByLabel.set(t.label ?? '', t)
  const finals = [...finalByLabel.values()]
  return {
    red: finals.some((t) => t.ok === false),
    green: finals.some((t) => t.ok === true && t.at >= lastCommitAt),
    passed: tests.filter((t) => t.ok === true).reduce((n, t) => n + count(t), 0),
    failed: tests.filter((t) => t.ok === false).reduce((n, t) => n + count(t), 0),
  }
}

// The judgement of `scope`: a delegation's agentId, or null for the whole session (the main thread
// and every agent). Total.
export const judge = (events: readonly OutcomeEvent[], scope: string | null): OutcomeJudgement => {
  const mine = commitsOf(events).filter((c) => scope === null || c.agent === scope)
  const live = mine.filter((c) => !c.reverted)
  const lastCommitAt = live.reduce((m, c) => Math.max(m, c.at), Number.NEGATIVE_INFINITY)
  const pr = prState(events, scope, mine)
  const t = testState(events, scope, lastCommitAt)
  const reverted = mine.length - live.length
  const base = { rounds: pr.rounds, commits: mine.length, reverted, possiblyDiscarded: live.filter((c) => c.discarded).length, testsPassed: t.passed, testsFailed: t.failed }
  const done = (verdict: Verdict, reason: OutcomeJudgement['reason']): OutcomeJudgement => ({ verdict, reason, ...base })
  if (reverted > 0) return done('not-achieved', 'reverted')
  if (pr.approved) return done('achieved', 'merged-approved')
  if (pr.stale) return done('unclear', 'approve-stale')
  if (pr.closed) return done('not-achieved', 'closed')
  if (pr.changes) return done('not-achieved', 'changes-requested')
  if (t.red && mine.length > 0) return done('not-achieved', 'tests-red')
  // A delegation is achieved by its PR alone; a session with commits and a green run after the last of them is verified work.
  if (scope === null && live.length > 0 && t.green && !t.red) return done('achieved', 'verified')
  return done('unclear', 'no-signal')
}

// Each session's outcome: the events' judgement when they say (external, observed), else the
// /insights facet when there is one. Both saying something different is counted in `disagree`, and the
// events stand. `sources` counts the sessions given by where their outcome came from.
export const combineOutcomes = (records: readonly TurnRecord[], facets: ReadonlyMap<string, Verdict>): { outcomes: Map<string, Verdict>; sources: OutcomeSources } => {
  const by = new Map<string, TurnRecord[]>()
  for (const r of records) by.set(r.session, [...(by.get(r.session) ?? []), r])
  const outcomes = new Map<string, Verdict>()
  const sources: OutcomeSources = { events: 0, facets: 0, both: 0, disagree: 0, unclear: 0 }
  for (const [session, rs] of by) {
    const fromEvents = judge(eventsOf(rs), null).verdict
    const fromFacet = facets.get(session) ?? 'unclear'
    if (fromEvents !== 'unclear') {
      outcomes.set(session, fromEvents)
      if (fromFacet === 'unclear') sources.events += 1
      else {
        sources.both += 1
        if (fromFacet !== fromEvents) sources.disagree += 1
      }
    } else if (fromFacet !== 'unclear') {
      outcomes.set(session, fromFacet)
      sources.facets += 1
    } else sources.unclear += 1
  }
  return { outcomes, sources }
}
