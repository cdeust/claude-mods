// Pure model routing: which model a subagent runs on, and whether main drops under quota.

import { type Pressure, agentModelFor } from './policy'

// source: ~/.claude/reference/agent-reference/effort-calibration.md § Which model when:
// Sonnet 5 for agile coding, agent planning and execution, efficient research; Opus/Fable for
// code review and bug-finding, security, formal verification, deep multi-file work; Haiku only
// for mechanical, fully planned execution (200K context, so not for an open search).
const SONNET_TYPES =
  /^(Explore|general-purpose|statusline-setup)$|engineer$|refactorer|simplifier|test-engineer|data-scientist|dba|devops|mlops|git-historian|paper-writer|latex|professor|ux-designer/i
const HEAVY = /opus|fable/i

export const SONNET = 'sonnet'

// Pressure first (policy.ts: one notch down, nothing protected); then, with no explicit model
// on the call or the agent definition, the type's own routing. An explicit model is kept.
export const routeAgentModel = (
  subagentType: string,
  declared: string | undefined,
  parentModel: string,
  pressure: Pressure,
): string | undefined => {
  const down = agentModelFor(declared, parentModel, pressure)
  if (down !== undefined) return down
  if (declared !== undefined || !HEAVY.test(parentModel)) return undefined
  return SONNET_TYPES.test(subagentType) ? SONNET : undefined
}

// Main thread: a model switch forfeits the prompt cache (the engine's model-change event
// carries `prompt_cache_warm` and `estimated_cache_write_usd` for that reason), so the lever
// is pulled for quota pressure alone, never from a request's class.
export const mainModelFor = (model: string, pressure: Pressure): string | undefined =>
  pressure === 'quota' && HEAVY.test(model) ? SONNET : undefined
