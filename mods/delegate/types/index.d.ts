export type Row = {
  id: string
  agentId?: string
  description: string
  type: string
  model: string
  effort: string
  // What the engine applied at the agent's first step (turn.step): the model id and the effort of that step.
  // Absent until a step is seen; the pane shows `?`.
  ranModel?: string
  ranEffort?: string
  // What the Agent call named (absent fields: not named) beside what the mod decided and which instrument decided it.
  asked: { model?: string; effort?: string }
  decided: Decision
  status: 'running' | 'done' | 'refused'
}
// by: 'fm' the on-device classifier, 'regex' the keyword fallback (reason starts with why fm did not answer), 'default'
// the fallback's own default, 'caller' a fork or a custom type, which the mod does not decide.
export type Decision = { model: string; effort: string; by: 'fm' | 'regex' | 'default' | 'caller'; reason: string }
// The classifier's learned character budget; 0 until an overflow taught one. It only shrinks.
export type FmState = { budget: number }
export type Blocked = { tool: string; mode: 'block' | 'warn' }

declare module 'claude-code' {
  interface PluginState {
    delegate: { rows: Shaped<Row[]>; blocked: Shaped<Blocked[]>; fm: Shaped<FmState> }
  }
}
