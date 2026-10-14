// The per-phase tool-loop effort the insights mod calibrated from its ledger, read from the file it
// writes (a mod never reads another's store; the insights mod depends on this one, not the reverse).

import type { Phase } from '../types'
import type { Effort } from './policy'

// source: zetetic-insights hooks/learn.ts CALIBRATION_PATH, the file it writes.
export const CALIBRATION_PATH = '~/.claude/zetetic-insights/calibration.json'

export type LoopCeilings = Partial<Record<Phase, Effort>>

const LEVELS: readonly string[] = ['low', 'medium', 'high']

// Version 1, a `phases` object of low/medium/high; anything else is refused with the reason.
export const parseCeilings = (text: string): LoopCeilings => {
  const raw = JSON.parse(text) as { version?: unknown; phases?: Record<string, unknown> }
  if (raw.version !== 1 || typeof raw.phases !== 'object' || raw.phases === null)
    throw new Error('calibration.json is not version 1 with a phases object')
  const bad = Object.entries(raw.phases).find(([, e]) => typeof e !== 'string' || !LEVELS.includes(e))
  if (bad !== undefined) throw new Error(`calibration.json: ${bad[0]} has effort ${String(bad[1])}, not low, medium or high`)
  return raw.phases as LoopCeilings
}
