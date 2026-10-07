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

// What the policy decided this session: observed, or applied under `enforce`.
export type PolicyDecision = {
  at: number
  kind: 'effort' | 'model' | 'lean' | 'stuck'
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

declare module 'claude-code' {
  interface PluginState {
    'zetetic-autopilot': {
      context: ContextHealth | null
      policy: PolicyState
    }
  }
}
