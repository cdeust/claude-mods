export type CortexStatus = 'pending' | 'measured' | 'blocked'

export type CortexEntry = {
  id: string
  tool: string
  startedAt: number
  status: CortexStatus
  ms?: number
  count?: number
  receipt?: number
}

export type GroomingKind = {
  days_since_last_run: number | null
  stale: boolean
}

export type CortexStats = {
  total_memories: number
  episodic_count: number
  semantic_count: number
  active_count: number
  archived_count: number
  stale_count: number
  protected_count: number
  avg_heat: number
  total_entities: number
  total_relationships: number
  active_triggers: number
  last_consolidation: string | null
  has_vector_search: boolean
  grooming_staleness: Record<string, GroomingKind>
  grooming_staleness_threshold_days: number
  readAt: number
}

export type TurnTally = {
  turns: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  tools: Record<string, number>
}

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
  readAt: number
}

// One stage of the spec-to-code pipeline, as observed from the tools the model called.
export type StageTally = {
  calls: number
  blocked: number
  lastAt: number | null
  lastTool: string | null
}

export type Refusal = {
  at: number
  tool: string
  rule: string
  target: string
}

export type Worktree = {
  path: string
  branch: string | null
  isMain: boolean
  isInsideRepoRule: boolean
  isRegistered: boolean
  owner: string | null
  pr: string | null
}

// What the policy decided this session: observed, or applied under `enforce`.
export type PolicyDecision = {
  at: number
  kind: 'effort' | 'model' | 'lean' | 'shape' | 'stuck'
  subject: string
  from: string
  to: string
  applied: boolean
}

// What the request classifier said about one prompt: pending until turn.start binds the turn.
export type Classified = {
  turnId: string | null
  text: string
  taskClass: 'routine' | 'planned' | 'bugfix' | 'analysis' | 'critical'
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  shapes: string[]
  ms: number
  at: number
}

export type PolicyState = {
  mode: 'observe' | 'enforce'
  pressure: 'none' | 'quota' | 'context'
  quotaPercent: number
  resultCapChars: number
  decisions: PolicyDecision[]
  charsCut: number
  classifierModel: string
  classified: Classified | null
  classifierError: string | null
  errorsInRow: number
  shapesLoaded: number
}

export type HygieneSnapshot = {
  worktrees: Worktree[]
  testProcesses: { pid: number; elapsed: string; command: string }[]
  error: string | null
  readAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'cortex-cockpit': {
      ledger: CortexEntry[]
      stats: CortexStats | null
      statsError: string | null
      tally: TurnTally
      context: ContextHealth | null
      stages: Record<string, StageTally>
      refusals: Refusal[]
      hygiene: HygieneSnapshot | null
      policy: PolicyState
    }
  }
}
