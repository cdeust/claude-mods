// What the orchestrator asked of each delegation and what came of it: the DESIGN block its prompt
// opened with (the dispatch-contract skill, parsed in design.ts), kept beside the agent's outcome, and four predicates
// that question a delegation. Each predicate is written once, in flagsOf; pure, so the register and
// the tests share it.

import type { AgentRecord, DelegationFlag, DelegationRow, DelegationStats, OutcomeEvent, TurnRecord } from '../types'
import { familyOf } from './models'
import { eventsBySession, judge } from './outcome'

export const OVERKILL_STEPS = 5 // source: own choice, an opus or fable agent that took at most this many steps did a small job
export const UNDERPOWERED_RATE = 0.25 // source: own choice, a flag on one small delegation, not a decision: one failed call in four (the old phase threshold; phases are now read with intervals, hooks/rungs.ts)
export const UNDERPOWERED_MIN_STEPS = 4 // source: own choice, fewer steps than this is too small a sample for a failure rate
export const RECENT_FLAGGED = 8 // source: own choice, the flagged delegations the panel can list

const FLAGS: readonly DelegationFlag[] = ['undesigned', 'rerouted', 'overkill', 'underpowered']

const REAL = new Set(['haiku', 'sonnet', 'opus', 'fable'])

// The four predicates, the only place each concept is defined:
//  - undesigned:   the prompt carried no DESIGN block (design === null). A record kept before the
//                  design was (design absent) is legacy: no flag.
//  - rerouted:     the design names a model of a real family, the model that ran is of a real family,
//                  and the two families differ (the autopilot may lower a model under quota pressure).
//  - overkill:     the model that ran is opus or fable and the agent took at most OVERKILL_STEPS steps.
//  - underpowered: the model that ran is haiku, it took at least UNDERPOWERED_MIN_STEPS steps and
//                  errors / steps >= UNDERPOWERED_RATE.
export const flagsOf = (r: AgentRecord): DelegationFlag[] => {
  const flags: DelegationFlag[] = []
  const ran = familyOf(r.model)
  if (r.design === null) flags.push('undesigned')
  const wanted = r.design?.model == null ? null : familyOf(r.design.model)
  if (wanted !== null && REAL.has(wanted) && REAL.has(ran) && wanted !== ran) flags.push('rerouted')
  if ((ran === 'opus' || ran === 'fable') && r.steps <= OVERKILL_STEPS) flags.push('overkill')
  if (ran === 'haiku' && r.steps >= UNDERPOWERED_MIN_STEPS && r.errors / r.steps >= UNDERPOWERED_RATE) flags.push('underpowered')
  return flags
}

export const emptyDelegations = (): DelegationStats => ({
  total: 0,
  designed: 0,
  outcomes: { achieved: 0, 'not-achieved': 0, unclear: 0 },
  rounds: 0,
  flags: { overkill: 0, underpowered: 0, undesigned: 0, rerouted: 0 },
  recent: [],
})

// One delegation is one agentId: a resumed agent writes a record per turn, summed here and judged
// once. A record without agentId (legacy) is its own delegation.
type Delegation = { agent: AgentRecord; at: number; session: string }

const delegationsOf = (records: readonly TurnRecord[]): Delegation[] => {
  const out: Delegation[] = []
  const byId = new Map<string, Delegation>()
  for (const rec of records) {
    for (const a of rec.agents) {
      const seen = a.agentId === undefined ? undefined : byId.get(a.agentId)
      if (seen === undefined) {
        const d = { agent: { ...a }, at: rec.at, session: rec.session }
        out.push(d)
        if (a.agentId !== undefined) byId.set(a.agentId, d)
        continue
      }
      const s = seen.agent
      s.steps += a.steps
      s.errors += a.errors
      if (a.tokensIn !== undefined) s.tokensIn = (s.tokensIn ?? 0) + a.tokensIn
      if (a.tokensOut !== undefined) s.tokensOut = (s.tokensOut ?? 0) + a.tokensOut
      if (s.design === undefined && a.design !== undefined) s.design = a.design
      s.model = a.model
      seen.at = rec.at
    }
  }
  return out
}

// Every delegation: `total` counts those that have a design field (null included), `designed` those
// whose design is not null, `flags` each flag over the delegation's summed steps and errors, `recent`
// the last RECENT_FLAGGED flagged rows, newest last. O(agents).
export const delegationStats = (records: readonly TurnRecord[]): DelegationStats => {
  const stats = emptyDelegations()
  const events = eventsBySession(records)
  for (const { agent: a, at, session } of delegationsOf(records)) {
    if (a.design === undefined) continue
    stats.total += 1
    if (a.design !== null) stats.designed += 1
    // The outcome the session's events show for this delegation; a legacy record (no agentId) has none to join.
    const joined = events.get(session)
    const judged = a.agentId === undefined ? undefined : judge(joined?.own ?? [], a.agentId, joined?.foreign)
    if (judged !== undefined) {
      stats.outcomes[judged.verdict] += 1
      stats.rounds += judged.rounds
    } else stats.outcomes.unclear += 1
    const flags = flagsOf(a)
    if (flags.length === 0) continue
    for (const f of FLAGS) if (flags.includes(f)) stats.flags[f] += 1
    const row: DelegationRow = {
      at,
      type: a.type,
      model: a.model,
      effort: a.design?.effort ?? null,
      shape: a.design?.shape ?? null,
      steps: a.steps,
      errors: a.errors,
      flags,
      ...(judged === undefined ? {} : { outcome: judged.verdict }),
    }
    stats.recent.push(row)
    if (stats.recent.length > RECENT_FLAGGED) stats.recent.shift()
  }
  return stats
}
