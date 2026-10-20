// What the mod reads and names as a row when it cannot: the request's grade (zetetic-genius), the calibration file, and
// whether the option keys of this install are the ones the engine reads. The row is the caller's (register.tsx `note`).
import type { EngineInterface, PluginState } from 'claude-code'

import { INSTALLED_PLUGINS_PATH } from './agents'
import { CALIBRATION_PATH, type LoopCeilings, parseCeilings } from './calibration'
import { SETTINGS_PATH, unboundKeys, unboundMessage } from './config'
import { expandHome } from './definitions'
import type { Note } from './records'
import type { TaskClass } from './route'

// The calibrated tool-loop rung per phase, read at start and at each new main turn: a missing file
// is no calibration; an unreadable one is a named row and no calibration.
export async function readCeilings($: EngineInterface, note: Note): Promise<LoopCeilings> {
  try {
    const path = await expandHome($, CALIBRATION_PATH)
    return (await $.fs.exists(path)) ? parseCeilings(await $.fs.read(path)) : {}
  } catch (error) {
    await note('calibration', `unreadable: ${String(error).slice(0, 100)}`)
    return {}
  }
}

// An option key the engine does not read for this install (config.ts): a toast, and a row in the POLICY
// panel, each time a session starts, instead of the defaults running unannounced.
export async function checkConfig($: EngineInterface, mode: string, note: Note): Promise<void> {
  try {
    const settingsPath = await expandHome($, SETTINGS_PATH)
    if (!(await $.fs.exists(settingsPath))) return
    const settings = String(await $.fs.read(settingsPath))
    const installedPath = await expandHome($, INSTALLED_PLUGINS_PATH)
    const installed = (await $.fs.exists(installedPath)) ? String(await $.fs.read(installedPath)) : undefined
    for (const u of unboundKeys(settings, installed, $.plugin.name, $.plugin.root)) {
      const message = unboundMessage(u, mode)
      await note('options not bound', message)
      $.ui.toast(message)
    }
  } catch (error) {
    await note('options not checked', String(error).slice(0, 120))
  }
}

// The classifier's verdict is zetetic-genius's state (a dependency): read, never written here.
const geniusState = { plugin: 'zetetic-genius', key: 'state' } as const
export type Grade = { turnId: string | null; taskClass: TaskClass; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }

// The current grade. A genius mod that is not loaded leaves the value undefined, a known state
// (no grade); a read that fails is another condition, named in a decision row (issue #6).
export async function gradeOf($: EngineInterface, note: Note): Promise<Grade | undefined> {
  let value: PluginState['zetetic-genius']['state'] | undefined
  try {
    value = (await $.state.get(geniusState)).value
  } catch (error) {
    await note('zetetic-genius state', `unreadable: ${String(error).slice(0, 100)}`)
    return undefined
  }
  const c = value?.classified
  return c === null || c === undefined ? undefined : { turnId: c.turnId, taskClass: c.taskClass, effort: c.effort }
}
