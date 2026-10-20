// A subagent's effort: who decides it, and what the mod keeps to apply it on each of the agent's steps.
// source: ADR-9850 (the invariant I1-I4, and why the decision is made at agent.spawn and applied at turn.step)
// agent.spawn can neither read nor set an effort; turn.step rewrites one, and the rewritten effort is the one in the
// API request (measured 2026-10-19, ~/.claude/fleet/research/mods-auto-dispatch-gap.md § 2.2). The two maps below
// live in this module's memory, as gate.ts's do, and are reset with the session.

import { type Definition, pinnedModel } from './agents'
import type { Effort } from './policy'
import { ROUTES_PER_SESSION } from './spawns'

// The codes under which another's effort stands and nothing is rewritten:
//   call        the Agent call set an effort
//   definition  the agent's definition sets an effort
//   pinned      the definition pins a model: not an inheriting type, the engine's effort stands
//   fixed       a fork, a workflow agent or a teammate: the engine runs it as its own
type Stands = 'call' | 'definition' | 'pinned' | 'fixed'

// The codes under which nothing could be decided, so the engine's effort stands too:
//   unseen      no Agent call was seen for the spawn (a hook's $.agent.spawn, a resume): its effort is unknown
//   unread      the definition could not be read: whether it sets an effort is unknown
//   ungraded    no grade bound to main's turn, or the spawn is a subagent's own
type Undecided = 'unseen' | 'unread' | 'ungraded'

// Why an agent's steps run at the effort they run at, the short code kept in its spawn record; `grade` is decided
// here: the effort of the grade of main's turn (zetetic-genius, class -> effort); `resumed`, a spawn raised again
// for an agent already held (a message resumed it): its steps keep the effort decided at its first spawn.
export type EffortReason = 'grade' | 'resumed' | Stands | Undecided

// What the spawn tells: `call` is the Agent call as tool.call saw it (undefined when none was seen), `definition`
// what the agent's file sets (undefined when it could not be read), `grade` the effort of the grade bound to main's
// turn (undefined when there is none, or when a subagent spawns).
export type SpawnFacts = {
  fixed: boolean
  call: { effort?: string } | undefined
  definition: Definition | undefined
  grade: Effort | undefined
}

export type Decided = { effort: Effort | undefined; reason: EffortReason }

// First match wins; every fact that makes the effort someone else's comes before the grade.
export const subagentEffort = (f: SpawnFacts): Decided => {
  const none = (reason: EffortReason): Decided => ({ effort: undefined, reason })
  if (f.fixed) return none('fixed')
  if (f.call === undefined) return none('unseen')
  if (f.call.effort !== undefined) return none('call')
  if (f.definition === undefined) return none('unread')
  if (f.definition.effort !== undefined) return none('definition')
  if (pinnedModel(f.definition) !== undefined) return none('pinned')
  if (f.grade === undefined) return none('ungraded')
  return { effort: f.grade, reason: 'grade' }
}

// source: own choice, the routes a session keeps (ROUTES_PER_SESSION): an agent the store no longer names is one this
// map may forget too. Far above the agents one session runs at once (max_parallel_agents, 5 by default).
export const EFFORTS_CAP = ROUTES_PER_SESSION

// `key` is set last; past `cap` the oldest entries go. A Map iterates in insertion order.
export const keep = <V>(m: Map<string, V>, key: string, value: V, cap: number): void => {
  m.delete(key)
  m.set(key, value)
  for (const oldest of m.keys()) {
    if (m.size <= cap) return
    m.delete(oldest)
  }
}

// The Agent calls running now, by tool_use_id, with the effort each set (null: none). An entry lives while its tool
// runs: the Agent tool raises agent.spawn from inside its call, with the tool_use_id the tool.call input carries.
const calls = new Map<string, Effort | null>()

// The decided effort of each agent the mod decided one for, by agent id. Kept past the agent's turn.complete: a
// message resumes an ended agent under the same id, and its resumed run keeps its effort. Bounded by EFFORTS_CAP.
const decided = new Map<string, Effort>()

export const isEffort = (v: unknown): v is Effort => v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh' || v === 'max'

export const callStarted = (toolUseId: string, effort: unknown): void => {
  keep(calls, toolUseId, isEffort(effort) ? effort : null, EFFORTS_CAP)
}

export const callEnded = (toolUseId: string): void => {
  calls.delete(toolUseId)
}

// The Agent call a spawn belongs to, as tool.call saw it; undefined when none is running under that id.
export const callOf = (toolUseId: string): { effort?: Effort } | undefined => {
  if (!calls.has(toolUseId)) return undefined
  const effort = calls.get(toolUseId)
  return effort === null || effort === undefined ? {} : { effort }
}

export const holdEffort = (agentId: string, effort: Effort): void => {
  keep(decided, agentId, effort, EFFORTS_CAP)
}

export const decidedFor = (agentId: string): Effort | undefined => decided.get(agentId)

export const resetEfforts = (): void => {
  calls.clear()
  decided.clear()
}

// The effort a subagent's step goes out at: the decided one, on a step that carries an effort level (absent: a model
// without effort, which is not given one; a number is not a level). Undefined: the step goes out as it came.
export const stepEffort = (designed: Effort | undefined, sent: unknown): Effort | undefined =>
  designed !== undefined && isEffort(sent) && sent !== designed ? designed : undefined
