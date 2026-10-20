// Pure model routing across the four families (fable, opus, sonnet, haiku): which model a
// subagent runs on, and whether main drops under quota. Families are matched by substring, so
// an alias (`haiku`) and a full id of any release (4.5, 5.5) resolve the same way.

import { type Definition, pinnedModel } from './agents'
import type { Steer } from './dispatch'
import type { Pressure } from './policy'

// Mirrors the zetetic-genius contract (its types/index.d.ts): a mod never imports across mods,
// so the class names are spelled here and checked where the state is read.
export type TaskClass = 'routine' | 'planned' | 'bugfix' | 'analysis' | 'critical'

// source: ~/.claude/reference/agent-reference/effort-calibration.md § Which model when.
// Haiku: a task fully planned by a more capable model with mechanical execution, bounded
// well-specified research. Sonnet: agile coding, agent planning and execution, efficient
// research. Opus: code review and bug-finding, security, formal verification, deep multi-file
// work. Fable: only when explicitly chosen, never the default upgrade path (twice the Opus rate).
// source: platform.claude.com/docs/en/models/haiku-5-5/whats-new-haiku-5-5 (released
// 2026-10-07): Haiku 5.5 is "built for high-volume, latency-sensitive work such as
// classification, routing, extraction, and subagent tasks", takes the effort parameter with
// adaptive thinking on by default, and has a 1M context window with 128k output (the 200K
// ceiling that kept Haiku 4.5 off open searches no longer applies to it).
export const FAMILIES = ['haiku', 'sonnet', 'opus', 'fable'] as const
export type Family = (typeof FAMILIES)[number]

export const familyOf = (model: string): Family | undefined => {
  const m = model.toLowerCase()
  return FAMILIES.find((f) => m.includes(f))
}

// Why a spawn runs on the model it runs on, the short code its record keeps (spawns.ts bounds a record's size):
//   call, definition  the Agent call's `model`, else the agent file's, stands
//   design            the spawn prompt's DESIGN block names the model (dispatch.ts)
//   table             an inheriting type nobody designed: the dispatch table's rung for its task's class
//   unclassified      the classifier gave no class: the parent's model; inherit: nothing decides, the parent's model
//   unread            neither a call model nor a readable definition: nothing was decided
export type RouteReason = 'call' | 'definition' | 'design' | 'table' | 'unclassified' | 'inherit' | 'unread'

// What the router decided for one spawn, and the facts it decided from (SpawnRoute in types/index.d.ts
// adds the agent, the clock and what the engine answered). `model` is the rewrite to send, undefined
// when the call stands as it is; `stands` is the model the spawn runs on without a rewrite.
export type Routed = {
  model: string | undefined
  requested: string | null
  definition: string | null
  stands: string
  reason: RouteReason
}

// The model a subagent runs on, first match wins: the call's `model`, the definition's, then what DESIGN or the table
// steer to (dispatch.ts), else the parent's. A model the call or the definition chose stands, always: no pressure,
// quota or context changes it, and neither DESIGN nor the table rewrites it (owner rule 2026-10-15; ADR-9851).
// `definition` undefined: the file could not be read, and with no call model nothing is decided (the row names why).
export const routeAgentModel = (call: string | undefined, definition: Definition | undefined, parentModel: string, steer: Steer): Routed => {
  const defined = definition === undefined ? undefined : pinnedModel(definition)
  const facts = { requested: call ?? null, definition: defined ?? null, stands: call ?? defined ?? `inherit ${parentModel}` }
  if (call === undefined && definition === undefined) return { ...facts, model: undefined, reason: 'unread' }
  if (call !== undefined) return { ...facts, model: undefined, reason: 'call' }
  if (defined !== undefined) return { ...facts, model: undefined, reason: 'definition' }
  if ((steer.by === 'design' || steer.by === 'table') && steer.model !== undefined) return { ...facts, model: steer.model, reason: steer.by }
  return { ...facts, model: undefined, reason: steer.by === 'unclassified' ? 'unclassified' : 'inherit' }
}

// The main step's `model` is sent to the Messages API as is, and the API knows full ids only:
// the CLI aliases (`sonnet`) are resolved by Claude Code before a session starts, not here.
// Sending `sonnet` made every main step fail over ("Switched to Opus 5 because sonnet is not
// available", 2026-10-14). The Agent tool's `model` is the alias enum, so subagents keep
// the aliases the dispatch table names (dispatch-table.ts).
// source: Claude model ids, Sonnet 5.5 = 'claude-sonnet-5-5' (measured 2026-10-14:
// `claude -p --model sonnet` reports modelUsage claude-sonnet-5-5)
export const SONNET_MAIN_ID = 'claude-sonnet-5-5'

// Main thread: a model switch forfeits the prompt cache (the engine's model-change event
// carries `prompt_cache_warm` and `estimated_cache_write_usd` for that reason), so the lever
// is pulled for quota pressure alone, never from a request's class. Owner's rule: heavy → sonnet.
export const mainModelFor = (model: string, pressure: Pressure): string | undefined => {
  const f = familyOf(model)
  return pressure === 'quota' && (f === 'opus' || f === 'fable') ? SONNET_MAIN_ID : undefined
}
