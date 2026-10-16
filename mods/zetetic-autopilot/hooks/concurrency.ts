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

// The max_parallel_agents option as set: a positive whole number, else the default and why. The engine refuses a
// value that is not a number (userConfig type: the hooks module does not load), so what reaches here is a number,
// and 0, a negative or a fraction is no count of agents.
export const maxParallelOption = (value: unknown): { max: number; problem?: string } => {
  if (value === undefined) return { max: MAX_PARALLEL_AGENTS }
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return { max: value }
  return { max: MAX_PARALLEL_AGENTS, problem: `max_parallel_agents=${JSON.stringify(value)} is not a positive whole number; using ${MAX_PARALLEL_AGENTS}` }
}

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

// Who is inside the orchestrator's budget: a spawn of the main loop's own Agent call, a fork of main included.
// The refusal says "wait for a running agent to finish, then spawn this one again", which only a caller that can
// wait and call again can act on, and the count is of the agents main started. Outside, neither refused nor
// counted (AgentSpawnInput, Claude Code 2.1.301 mods types):
// - `parentAgentId` set: "absent from main"; the spawn happens inside a subagent's or a teammate's loop and is
//   part of the work of the place its parent already holds. Refusing it locked a chain k deep at cap k.
// - `workflow` set: a script's agent(). "A hook can only refuse it", and the script cannot wait and retry: the
//   refusal is an error inside the run. $.agent.list() does not list a workflow's agents either.
// - `isTeammate`: "goes idle between turns and wakes on a message", so its turn.complete frees nothing.
// A fork of main stays inside: `fork` is an Agent call main made (subagentType `fork`), main can wait, and it
// spends the quota any subagent does. The engine's own forks (compaction, memory) raise no agent.spawn: the
// event is raised for the Agent tool's agents and a workflow's agent() only.
export const inBudget = (e: { parentAgentId?: string; workflow?: unknown; isTeammate?: true }): boolean =>
  e.parentAgentId === undefined && e.workflow === undefined && e.isTeammate !== true

// A spawn is refused when `running` agents already fill the cap.
export const isRefused = (running: number, cap: number): boolean => running >= cap

// The cap as the quota sets it: its value, the window's use, and the band the cap falls across.
const capOf = (cap: number, usedPercent: number | undefined, quotaPercent: number, max: number): string =>
  `${cap} at ${usedPercent === undefined ? 'an unread share' : `${Math.round(usedPercent)}%`} of the five-hour window ` +
  `(the cap falls from ${max} to ${MIN_PARALLEL_AGENTS} as the window fills to ${quotaPercent}%)`

// Two readers, two texts (the engine's declarations: a toast "leaves the transcript and the model untouched", a
// spawn's deny is "the Agent tool's error" the model reads). The refusal below is the model's, with the way out.
// The status after it is the user's, who cannot spawn or wait: the fact, and no instruction.
//
// The reason the orchestrator reads as the Agent tool's error: the counts, the quota, the way out.
export const refusalMessage = (running: number, cap: number, usedPercent: number | undefined, quotaPercent: number, max = MAX_PARALLEL_AGENTS): string =>
  `zetetic-autopilot: ${running} subagent${running === 1 ? ' is' : 's are'} running and the cap is ` +
  `${capOf(cap, usedPercent, quotaPercent, max)}. Wait for a running agent to finish, then spawn this one again.`

// What the user reads (a toast, and the POLICY row): which spawn was refused and the numbers behind it.
export const capStatus = (subagentType: string, running: number, cap: number, usedPercent: number | undefined, quotaPercent: number, max = MAX_PARALLEL_AGENTS): string =>
  `zetetic-autopilot: spawn of ${subagentType} refused, ${running} subagent${running === 1 ? '' : 's'} running, cap ` +
  `${capOf(cap, usedPercent, quotaPercent, max)}`

// Of the agents the autopilot believes are running (spawned, no turn.complete seen), those the engine's own
// list confirms are alive. The list is consulted only on the path that would refuse: an agent that ended
// without a turn.complete this mod saw (killed, dropped by the engine) must not hold a slot for good.
const ALIVE: readonly AgentInfo['status'][] = ['pending', 'running', 'waiting']
export const stillRunning = (believed: readonly string[], listed: readonly Pick<AgentInfo, 'id' | 'status'>[]): string[] =>
  believed.filter((id) => ALIVE.includes(listed.find((a) => a.id === id)?.status ?? 'completed'))
