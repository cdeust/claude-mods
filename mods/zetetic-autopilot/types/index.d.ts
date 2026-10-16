// The autopilot's contract: the live context window it measures, and what it decided.

// The live context window, with the checkpoint thresholds the Stop guard enforces.
export type ContextHealth = {
  tokens: number | null
  window: number
  percent: number | null
  model: string
  warn: number | null
  hard: number | null
  thresholdsSource: string
  rateLimits: { kind: string; percentUsed: number }[]
  usd: number | null
  // The window by category and the MCP servers' tool schemas, as /context estimates them.
  categories: { name: string; tokens: number }[]
  mcpServers: { server: string; tools: number; tokens: number }[]
  // Where the reading sits against the thresholds; computed once here so viewers need no rule.
  band: 'measured' | 'warn' | 'hard' | 'unknown'
  readAt: number
}

export type Pressure = 'none' | 'quota' | 'context'

// What the policy decided this session: observed, or applied under `enforce`. `unread` names a
// source routing went on without (a dependency's state, an agent definition) and why. `cap` is a
// spawn refused (or, observed, that would be) because the quota's cap on parallel subagents was
// reached; `work` a warning that the main loop itself did implementation work (never applied).
export type PolicyDecision = {
  at: number
  kind: 'effort' | 'model' | 'offload' | 'stuck' | 'unread' | 'cap' | 'work'
  subject: string
  from: string
  to: string
  applied: boolean
  // Why, for a model decision: absent on the other kinds and on rows written before it was kept.
  reason?: string
}

// How one subagent's model was decided, kept per spawn so an outcome is attributed to the model
// that ran (hooks/route.ts). `requested` is the Agent call's `model`, `definition` the model its
// agent file pins (null: none, `inherit`, or the file was not read), `decided` what the router
// settled on (the call's, else the definition's, else `inherit <parent model>`), `ran` what the
// engine answered it runs on, `reason` the rule that decided as a short code (call, definition, kind,
// inherit, unread: hooks/route.ts), `applied` true when a rewrite was sent (false when the call stood
// as it was, or observe mode only logged the rewrite). Every string is clipped (spawns.ts), so the
// size of a record, and of the store, is bounded.
export type SpawnRoute = {
  at: number
  agentId: string
  type: string
  requested: string | null
  definition: string | null
  decided: string
  ran: string
  reason: 'call' | 'definition' | 'kind' | 'inherit' | 'unread'
  applied: boolean
}

export type PolicyState = {
  mode: 'observe' | 'enforce'
  pressure: Pressure
  quotaPercent: number
  offloadThresholdChars: number
  offloadPreviewChars: number
  decisions: PolicyDecision[]
  // Characters kept out of the context by offloads, net of the pointers that replaced them.
  charsOffloaded: number
  errorsInRow: number
}

// The phase a loop is in, read off what it does (hooks/phases.ts). Implementation is the eighth,
// added to the owner's seven for the steps that write code.
export type Phase = 'planning' | 'analysis' | 'design' | 'implementation' | 'verification' | 'test' | 'review' | 'report'

// A stretch of consecutive steps in one phase at one effort, and the tool calls that failed in it.
// `reads`: the run's steps whose every tool call was a file read (Read, Grep, Glob), the work any
// model could do; absent on runs recorded before it was counted.
// `escalated`: the run's steps whose effort the stuck escalation set (hooks/register.tsx turn.step): a
// main step after STUCK_ERRORS failed tool calls in a row, when escalating raised the ladder's target,
// under `enforce`. Counted on the step as it is recorded, so it is on the run the raised step landed
// in, whether that step opened a run or joined the one before it. The run's phase is the step's own
// (what it did); the failures that triggered it and the ceiling the ladder's target came from are the
// steps before it, in whatever phase they were. The count includes a step whose raised effort equals
// the one it came with (it went out unchanged, and no decision row was logged, but without the
// escalation it would have gone out lower). 0 under `observe` (nothing is applied) and on a run with
// no such step; absent on runs recorded before it was counted (0.7.x and earlier): unknown, not none.
export type PhaseRun = {
  phase: Phase
  effort: string | null
  steps: number
  errors: number
  since: number
  reads?: number
  escalated?: number
}

// One loop of this session: main (its row starts again each turn) or a subagent.
export type LoopPhases = {
  id: string
  type: string
  description: string
  model: string
  effort: string | null
  // An agent whose type names a phase stays in it; main and other types follow their steps.
  phase: Phase | null
  runs: PhaseRun[]
  status: 'running' | 'done'
  advisorCalls: number
  // The turn wrote something (implementation, design, test) before now.
  wrote: boolean
  updatedAt: number
}

// One step of main in which the advisor (a server tool the API runs) was called.
export type AdvisorUse = {
  at: number
  turnId: string | null
  phase: Phase | null
  when: 'before-write' | 'after-write' | 'at-completion'
  calls: number
}

export type PhasesState = {
  turnId: string | null
  loops: LoopPhases[]
  advisor: { session: number; uses: AdvisorUse[] }
}

declare module 'claude-code' {
  interface PluginState {
    'zetetic-autopilot': {
      context: ContextHealth | null
      policy: PolicyState
      phases: PhasesState
      // The newest spawns' routes, newest last; every route is also kept in the plugin's $.store, in
      // its session's key `spawns:<start time>:<session id>` (hooks/spawns.ts).
      spawns: SpawnRoute[]
    }
  }
}
