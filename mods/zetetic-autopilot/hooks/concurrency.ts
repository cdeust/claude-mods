// How many subagents may run at once, as a function of the quota. Owner rule, 2026-10-15: the quota
// limits the number of agents and of parallel tasks, never how well one agent runs (route.ts leaves a
// designed model and effort alone under any pressure).

import type { AgentInfo } from 'claude-code'

// What the engine allows at `agent.spawn` (Claude Code 2.1.300, AgentSpawnResult in the mods types, read
// 2026-10-15): a hook returns `{ deny: reason }` and "the model sees the text as the Agent tool's error".
// There is no hold or delay: `next` resolves only once the subagent started, and a hook that waits holds
// the whole Agent call. So the strongest mechanism is the refusal, with a reason the orchestrator can act
// on (wait for a running agent to finish, spawn again).

// source: ~/.claude/reference/agent-reference/dynamic-workflows.md, "Agent tool with 2-5 focused subagents - covers most parallel analysis needs"; fan-out above 5 is gated by a cost review there
export const MAX_PARALLEL_AGENTS = 5

// source: logic. A refusal says "wait for a running agent", which needs one running: with a cap of 1 the first spawn always passes, so the orchestrator is never locked out
export const MIN_PARALLEL_AGENTS = 1

// The cap for a five-hour window `usedPercent` full: `max` at an empty window, MIN at `quotaPercent` (the
// quota_pressure_percent option, default 80) and past it, a straight line between, rounded up so a nearly
// empty window still has the full cap:
//   cap(u) = max(MIN, ceil(max - (max - MIN) * u / quotaPercent))
// source: own choice of the simplest monotone function through the two ends above. With max 5 and
// quotaPercent 80: 0-19% -> 5, 20-39% -> 4, 40-59% -> 3, 60-79% -> 2, 80%+ -> 1 (tested at each edge).
// No reading of the window (undefined) leaves the cap at max: the quota is unknown, so it limits nothing.
export const parallelCap = (usedPercent: number | undefined, quotaPercent: number, max = MAX_PARALLEL_AGENTS): number => {
  if (usedPercent === undefined) return Math.max(MIN_PARALLEL_AGENTS, max)
  if (!(quotaPercent > 0) || usedPercent >= quotaPercent) return MIN_PARALLEL_AGENTS
  const share = Math.max(0, usedPercent) / quotaPercent
  return Math.max(MIN_PARALLEL_AGENTS, Math.ceil(max - (max - MIN_PARALLEL_AGENTS) * share))
}

// The five-hour window's use out of the engine's rate limits, undefined without a reading.
export const fiveHourPercent = (rateLimits: readonly { kind: string; percentUsed: number }[]): number | undefined =>
  rateLimits.find((r) => r.kind === 'five_hour')?.percentUsed

// A spawn is refused when `running` agents already fill the cap.
export const isRefused = (running: number, cap: number): boolean => running >= cap

// The reason the orchestrator reads as the Agent tool's error: the counts, the quota, the way out.
export const refusalMessage = (running: number, cap: number, usedPercent: number | undefined, quotaPercent: number, max = MAX_PARALLEL_AGENTS): string =>
  `zetetic-autopilot: ${running} subagent${running === 1 ? ' is' : 's are'} running and the cap is ${cap} at ` +
  `${usedPercent === undefined ? 'an unread share' : `${Math.round(usedPercent)}%`} of the five-hour window ` +
  `(the cap falls from ${max} to ${MIN_PARALLEL_AGENTS} as the window fills to ${quotaPercent}%). ` +
  'Wait for a running agent to finish, then spawn this one again.'

// Of the agents the autopilot believes are running (spawned, no turn.complete seen), those the engine's own
// list confirms are alive. The list is consulted only on the path that would refuse: an agent that ended
// without a turn.complete this mod saw (killed, dropped by the engine) must not hold a slot for good.
const ALIVE: readonly AgentInfo['status'][] = ['pending', 'running', 'waiting']
export const stillRunning = (believed: readonly string[], listed: readonly Pick<AgentInfo, 'id' | 'status'>[]): string[] =>
  believed.filter((id) => ALIVE.includes(listed.find((a) => a.id === id)?.status ?? 'completed'))
