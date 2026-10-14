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
// source routing went on without (a dependency's state, an agent definition) and why.
export type PolicyDecision = {
  at: number
  kind: 'effort' | 'model' | 'lean' | 'stuck' | 'unread'
  subject: string
  from: string
  to: string
  applied: boolean
}

export type PolicyState = {
  mode: 'observe' | 'enforce'
  pressure: Pressure
  quotaPercent: number
  resultCapChars: number
  decisions: PolicyDecision[]
  charsCut: number
  errorsInRow: number
}

// The phase a loop is in, read off what it does (hooks/phases.ts). Implementation is the eighth,
// added to the owner's seven for the steps that write code.
export type Phase = 'planning' | 'analysis' | 'design' | 'implementation' | 'verification' | 'test' | 'review' | 'report'

// A stretch of consecutive steps in one phase.
export type PhaseRun = { phase: Phase; steps: number; since: number }

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
    }
  }
}
