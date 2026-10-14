import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { type Choice, chooseRenderer } from './renderer'
import { sceneOf } from './scene'
import { CellsView, PixelsView, TextView } from './view'

const PANE = 'mission-control'
const TITLE = 'Mission'
const renderer = atom({ plugin: 'mission-control', key: 'renderer' } as const, { renderer: 'cells', reason: 'not chosen yet' } as Choice)

// The dependencies' state, as their contracts declare it.
const AUTOPILOT_PHASES = { plugin: 'zetetic-autopilot', key: 'phases' } as const
const INSIGHTS = { plugin: 'zetetic-insights', key: 'insights' } as const

const cut = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 120)

async function choose($: EngineInterface, setting: unknown): Promise<void> {
  const choice = chooseRenderer(setting, {
    tmux: await $.env.get('TMUX'),
    term: await $.env.get('TERM'),
    termProgram: await $.env.get('TERM_PROGRAM'),
    kittyWindow: await $.env.get('KITTY_WINDOW_ID'),
  })
  await update($, renderer, () => choice)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await choose($, options.renderer)
    try {
      await $.command.register({ name: 'mission', description: 'Open the mission-control pane: lanes by phase, effort, advisor calls, learning curves', immediate: true })
    } catch (error) {
      $.ui.toast(`/mission is taken by another plugin: ${cut(error).slice(0, 80)}`)
    }

    return next(e)
  })

  // /clear, /resume and /branch reset $.state and never fire session.start again.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await choose($, options.renderer)

    return next(e)
  })

  on('command.run', { command: 'mission' }, async ($) => {
    const { isPlaced } = await $.ui.open({ id: PANE, title: TITLE })
    const r = await read($, renderer)
    return { text: `Mission control ${isPlaced ? 'opened' : 'waits for room (144 columns, or 110 in fullscreen)'}; drawn in ${r.renderer} (${r.reason}).` }
  })

  // Redrawn whenever the autopilot's phases or the insights change: the reads subscribe it.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const phases = (await $.state.get(AUTOPILOT_PHASES)).value ?? null
    const insights = (await $.state.get(INSIGHTS)).value ?? null
    const scene = sceneOf(phases, insights, await $.clock.now())
    if (e.surface !== 'terminal') return TextView($.ui.resolve(e) as never, scene)
    const ui = $.ui.resolve(e)
    const r = await read($, renderer)
    return r.renderer === 'pixels' ? PixelsView(ui, scene, e.props.bodyColumns) : CellsView(ui, scene, e.props.bodyColumns)
  })
}
