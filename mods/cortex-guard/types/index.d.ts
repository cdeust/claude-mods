// One refused call: when, which tool, which rule, and what it aimed at.
export type Refusal = {
  at: number
  tool: string
  rule: string
  target: string
}

declare module 'claude-code' {
  interface PluginState {
    'cortex-guard': {
      refusals: Refusal[]
    }
  }
}
