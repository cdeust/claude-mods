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
// by: 'fm', 'jev' or 'fm+jev' the model(s) that answered (both: the higher class), 'user' the person chose (asked, or the
// retry that named the choice), 'caller' a fork or a custom type, which the mod does not decide, 'none' a call refused
// because no model answered and the user is to choose.
export type Decision = { model: string; effort: string; by: 'fm' | 'jev' | 'fm+jev' | 'user' | 'caller' | 'none'; reason: string }
// A refused Agent call waiting for the user's choice: its description, the mark its questions carry, and, once the user
// has answered an AskUserQuestion that carries the mark, the model and the effort chosen. Taken once, by a call with
// that description; dropped at the start or the end of a turn.
export type Ask = { key: string; mark: string; model?: string; effort?: string }
export type Blocked = { tool: string; mode: 'block' | 'warn' }

declare module 'claude-code' {
  interface PluginState {
    delegate: { rows: Shaped<Row[]>; blocked: Shaped<Blocked[]>; asks: Shaped<Ask[]> }
  }
}
