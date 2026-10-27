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
  // 'main' when the Agent call named the model, 'mod' when the router filled it
  by: 'main' | 'mod'
  rule: string
  status: 'running' | 'done' | 'refused'
}
export type Blocked = { tool: string; mode: 'block' | 'warn' }

declare module 'claude-code' {
  interface PluginState {
    delegate: { rows: Shaped<Row[]>; blocked: Shaped<Blocked[]> }
  }
}
