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

// One stage of the spec-to-code pipeline, as observed from the tools the model called.
export type StageTally = {
  calls: number
  blocked: number
  lastAt: number | null
  lastTool: string | null
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
      stages: Record<string, StageTally>
      hygiene: HygieneSnapshot | null
    }
  }
}
