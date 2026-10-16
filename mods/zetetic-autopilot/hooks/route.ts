// Pure model routing across the four families (fable, opus, sonnet, haiku): which model a
// subagent runs on, and whether main drops under quota. Families are matched by substring, so
// an alias (`haiku`) and a full id of any release (4.5, 5.5) resolve the same way.

import { type Definition, pinnedModel } from './agents'
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

export const SONNET = 'sonnet'
export const HAIKU = 'haiku'
export const OPUS = 'opus'

export const familyOf = (model: string): Family | undefined => {
  const m = model.toLowerCase()
  return FAMILIES.find((f) => m.includes(f))
}

const MECHANICAL_TYPES = /^(Explore|general-purpose|statusline-setup)$|memory-writer|git-historian/i
const CODING_TYPES =
  /engineer$|refactorer|simplifier|test-engineer|data-scientist|dba|devops|mlops|paper-writer|latex|professor|ux-designer/i
const REVIEW_TYPES = /code-reviewer|security-auditor|architect|advisor|reviewer-academic|^Plan$|dispatch|orchestrator/i

// Classes whose execution is mechanical once the request is read (classify.ts).
const MECHANICAL_CLASSES: readonly TaskClass[] = ['routine', 'planned']

// Why a spawn runs on the model it runs on, as the short code kept in the per-spawn record (spawns.ts
// bounds the store by the size of a record, so the sentence is composed where it is shown, not kept):
//   call        the Agent call's `model` stands
//   definition  the agent file's `model` stands
//   kind        an inheriting type, routed by its kind sharpened by the turn's task class
//   inherit     an inheriting type nothing routes: it runs on the parent's model
//   unread      neither a call model nor a readable definition: nothing was decided
export type RouteReason = 'call' | 'definition' | 'kind' | 'inherit' | 'unread'

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

const byKind = (subagentType: string, parentModel: string, taskClass?: TaskClass): string | undefined => {
  const parent = familyOf(parentModel)
  if (parent === undefined || parent === HAIKU || parent === SONNET) return undefined
  const isMechanical = taskClass !== undefined && MECHANICAL_CLASSES.includes(taskClass)
  if (MECHANICAL_TYPES.test(subagentType)) return isMechanical ? HAIKU : SONNET
  if (CODING_TYPES.test(subagentType)) return taskClass === 'planned' ? HAIKU : SONNET
  if (REVIEW_TYPES.test(subagentType)) return parent === 'fable' ? OPUS : undefined
  return undefined
}

// The model a subagent runs on, in this order: the call's `model`, else its definition's, else the
// parent's. A model the call or the definition chose stands, always: no pressure, quota or context,
// changes it (the owner's rule, 2026-10-15: the quota limits how many subagents run at once, concurrency.ts,
// never how well one runs). An inheriting type, which nobody chose a model for, is routed by its kind
// sharpened by the turn's task class, and otherwise inherits the parent's model, which is what the
// engine does when `model` is left undefined (AgentSpawnInput.model: "undefined lets the agent's own
// model, then the parent's, decide"). `definition` undefined means the file could not be read: with no
// call model either, the effective model is unknown and nothing is routed (the decision row names why).
export const routeAgentModel = (
  subagentType: string,
  call: string | undefined,
  definition: Definition | undefined,
  parentModel: string,
  taskClass?: TaskClass,
): Routed => {
  const defined = definition === undefined ? undefined : pinnedModel(definition)
  const facts = { requested: call ?? null, definition: defined ?? null, stands: call ?? defined ?? `inherit ${parentModel}` }
  if (call === undefined && definition === undefined) return { ...facts, model: undefined, reason: 'unread' }
  if (call !== undefined) return { ...facts, model: undefined, reason: 'call' }
  if (defined !== undefined) return { ...facts, model: undefined, reason: 'definition' }
  const kind = byKind(subagentType, parentModel, taskClass)
  return kind === undefined ? { ...facts, model: undefined, reason: 'inherit' } : { ...facts, model: kind, reason: 'kind' }
}

// The main step's `model` is sent to the Messages API as is, and the API knows full ids only:
// the CLI aliases (`sonnet`) are resolved by Claude Code before a session starts, not here.
// Sending `sonnet` made every main step fail over ("Switched to Opus 5 because sonnet is not
// available", 2026-10-14). The Agent tool's `model` is the alias enum, so subagents keep
// `SONNET`/`HAIKU`/`OPUS` above.
// source: Claude model ids, Sonnet 5.5 = 'claude-sonnet-5-5' (measured 2026-10-14:
// `claude -p --model sonnet` reports modelUsage claude-sonnet-5-5)
export const SONNET_MAIN_ID = 'claude-sonnet-5-5'

// Main thread: a model switch forfeits the prompt cache (the engine's model-change event
// carries `prompt_cache_warm` and `estimated_cache_write_usd` for that reason), so the lever
// is pulled for quota pressure alone, never from a request's class. Owner's rule: heavy → sonnet.
export const mainModelFor = (model: string, pressure: Pressure): string | undefined => {
  const f = familyOf(model)
  return pressure === 'quota' && (f === OPUS || f === 'fable') ? SONNET_MAIN_ID : undefined
}
