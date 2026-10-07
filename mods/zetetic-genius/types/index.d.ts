// The request classifier's contract: what it decided about the current prompt.

// source: ~/.claude/reference/agent-reference/effort-calibration.md § Effort levels (task table).
export type TaskClass = 'routine' | 'planned' | 'bugfix' | 'analysis' | 'critical'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// One genius reasoning pattern picked for the request, by the shape that matched.
export type GeniusPick = { agent: string; shape: string }

// What the classifier said about one prompt: pending (turnId null) until turn.start binds it.
export type Classified = {
  turnId: string | null
  text: string
  taskClass: TaskClass
  effort: Effort
  shapes: string[]
  geniuses: GeniusPick[]
  ms: number
  at: number
}

export type GeniusDecision = {
  at: number
  kind: 'shape' | 'genius'
  subject: string
  to: string
  applied: boolean
}

export type GeniusState = {
  mode: 'observe' | 'enforce'
  classifierModel: string
  classified: Classified | null
  classifierError: string | null
  skillShapesLoaded: number
  geniusShapesLoaded: number
  geniusDir: string | null
  decisions: GeniusDecision[]
}

declare module 'claude-code' {
  interface PluginState {
    'zetetic-genius': {
      state: GeniusState
    }
  }
}
