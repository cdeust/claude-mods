// mission-control keeps one value: the renderer chosen at session start, so a redraw does not read
// the environment again.

export type Renderer = 'cells' | 'pixels'

declare module 'claude-code' {
  interface PluginState {
    'mission-control': {
      renderer: { renderer: Renderer; reason: string }
    }
  }
}
