// The insights mod's contract: what the ledger says per phase and agent, the session outcomes and
// goals it joins, and the effort per phase it proposes and, applied, writes for the autopilot.

// Mirrors zetetic-autopilot's `Phase` (a mod never imports across mods).
export type Phase = 'planning' | 'analysis' | 'design' | 'implementation' | 'verification' | 'test' | 'review' | 'report'
export type Effort = 'low' | 'medium' | 'high'

export type RunRecord = { phase: Phase; effort: string | null; steps: number; errors: number }

// The design contract a delegation was dispatched under, read from the DESIGN block of its prompt
// (the dispatch-contract skill): the model and effort the orchestrator chose and the genius shape it
// handed over. Each field null when the block does not state it.
export type Design = { model: string | null; effort: string | null; shape: string | null }

export type AgentRecord = {
  type: string
  phase: Phase | null
  model: string
  steps: number
  errors: number
  // What it was dispatched under: null when the prompt carried no DESIGN block; absent on records
  // written before the design was kept.
  design?: Design | null
  // Tokens its turns used, as the API reported them: input (uncached, cache read and cache write
  // together) and output. Absent when no usage was reported.
  tokensIn?: number
  tokensOut?: number
}

// A delegation the evidence questions, and why (hooks/delegations.ts).
export type DelegationFlag = 'overkill' | 'underpowered' | 'undesigned' | 'rerouted'
export type DelegationRow = { at: number; type: string; model: string; effort: string | null; shape: string | null; steps: number; errors: number; flags: DelegationFlag[] }
export type DelegationStats = {
  total: number
  designed: number
  flags: Record<DelegationFlag, number>
  // The newest flagged delegations, newest last.
  recent: DelegationRow[]
}

// One main turn as the ledger keeps it ($.store, across sessions).
export type TurnRecord = {
  session: string
  turnId: string
  at: number
  taskClass: string | null
  main: RunRecord[]
  agents: AgentRecord[]
  // The model main ran on this turn (autopilot phases, main loop); absent on records written before
  // it was kept, counted as `unknown`.
  mainModel?: string
  // Agents finished in the turn past MAX_AGENTS, counted, not kept (learn.ts).
  agentsDropped?: number
  advisor: { calls: number; beforeWrite: number; atCompletion: number }
  stuck: number
}

// Main's steps in one phase at one effort, and the outcomes /insights gave their sessions.
export type PhaseStat = {
  phase: string
  effort: string
  steps: number
  errors: number
  sessions: number
  judged: number
  achieved: number
}

export type AgentStat = { type: string; runs: number; steps: number; errors: number; models: string[] }

export type Proposal = { phase: Phase; from: Effort; to: Effort; evidence: string }

// The file the autopilot reads: the tool-loop effort of each calibrated phase, and why.
export type Calibration = {
  version: 1
  phases: Partial<Record<Phase, Effort>>
  evidence: Partial<Record<Phase, string>>
  // Each phase's last move: only the runs recorded after it count, and undoing it needs more.
  changes: Partial<Record<Phase, { at: number; from: Effort; to: Effort }>>
  updatedAt: number | null
}

// One phase's learning curve: failed-call rate per bucket of consecutive turns, oldest first, and
// the calibration's last move of that phase (hooks/trend.ts).
export type PhaseTrend = {
  phase: Phase
  points: { at: number; steps: number; rate: number }[]
  move: { at: number; from: Effort; to: Effort } | null
}

// Who did the steps: a model id reduced to its family (hooks/models.ts).
export type ModelFamily = 'haiku' | 'sonnet' | 'opus' | 'fable' | 'other' | 'unknown'
export type ModelSteps = { family: ModelFamily; steps: number }
// One session's steps by family, main's and its agents' together; families with no step left out.
export type SessionModels = { session: string; at: number; steps: ModelSteps[] }

export type InsightsState = {
  mode: 'observe' | 'enforce'
  turns: number
  sessions: number
  judgedSessions: number
  ledgerError: string | null
  facetsError: string | null
  phases: PhaseStat[]
  trends: PhaseTrend[]
  // The ledger's last sessions (at most 12, oldest first), by when their last turn ended.
  models: SessionModels[]
  // The ledger's delegations judged against their design (hooks/delegations.ts).
  delegations: DelegationStats
  agents: AgentStat[]
  advisor: { heavyTurns: number; heavyBeforeWrite: number; heavyAtCompletion: number; lightTurns: number; lightWithAdvisor: number }
  goals: { name: string; status: string }[]
  goalsError: string | null
  calibration: Calibration
  calibrationError: string | null
  proposals: Proposal[]
  updatedAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'zetetic-insights': {
      insights: InsightsState
    }
  }
}
