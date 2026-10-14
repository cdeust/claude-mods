// mission-control keeps two values: the renderer chosen at session start, so a redraw does not read
// the environment again; and main's runs of the last turns, which the autopilot starts afresh each
// turn, so the lanes show the recent past and not the current turn alone.

export type Renderer = 'cells' | 'pixels'

export type PastRun = { phase: string; effort: string | null; steps: number; errors: number; since: number; until: number }
export type PastTurn = { turnId: string; model: string; runs: PastRun[] }

declare module 'claude-code' {
  interface PluginState {
    'mission-control': {
      renderer: { renderer: Renderer; reason: string }
      history: PastTurn[]
    }
  }
}
