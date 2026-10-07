// Pure model routing across the four families (fable, opus, sonnet, haiku): which model a
// subagent runs on, and whether main drops under quota. Families are matched by substring, so
// an alias (`haiku`) and a full id of any release (4.5, 5.5) resolve the same way.

import type { TaskClass } from './classify'
import { type Pressure, agentModelFor } from './policy'

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

// Pressure first (policy.ts, the owner's rule: opus/fable one notch down to sonnet, nothing
// protected). Then, with no explicit model on the call or the agent definition and a heavy
// parent, the type's own routing, sharpened by the turn's task class when it is known.
export const routeAgentModel = (
  subagentType: string,
  declared: string | undefined,
  parentModel: string,
  pressure: Pressure,
  taskClass?: TaskClass,
): string | undefined => {
  const down = agentModelFor(declared, parentModel, pressure)
  if (down !== undefined) return down
  const parent = familyOf(parentModel)
  if (declared !== undefined || parent === undefined || parent === HAIKU || parent === SONNET) return undefined
  const isMechanical = taskClass !== undefined && MECHANICAL_CLASSES.includes(taskClass)
  if (MECHANICAL_TYPES.test(subagentType)) return isMechanical ? HAIKU : SONNET
  if (CODING_TYPES.test(subagentType)) return taskClass === 'planned' ? HAIKU : SONNET
  if (REVIEW_TYPES.test(subagentType)) return parent === 'fable' ? OPUS : undefined
  return undefined
}

// Main thread: a model switch forfeits the prompt cache (the engine's model-change event
// carries `prompt_cache_warm` and `estimated_cache_write_usd` for that reason), so the lever
// is pulled for quota pressure alone, never from a request's class. Owner's rule: heavy → sonnet.
export const mainModelFor = (model: string, pressure: Pressure): string | undefined => {
  const f = familyOf(model)
  return pressure === 'quota' && (f === OPUS || f === 'fable') ? SONNET : undefined
}
