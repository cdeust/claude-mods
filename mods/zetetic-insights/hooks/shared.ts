import type { EngineInterface } from 'claude-code'

import type { InsightsState, TurnRecord } from '../types'
import type { Layout } from './ledger'
import { emptyDelegations } from './delegations'
import { emptyCalibration } from './learn'
import { placePath } from './paths'

// The panel's initial state and the small helpers the register and the modules split from it share. The
// engine's scan reads a state handle only where it is declared in the file that uses it, so each file
// that reads or writes the panel declares `atom({ plugin, key }, INITIAL)` itself.

export const INITIAL: InsightsState = {
  mode: 'observe',
  turns: 0,
  sessions: 0,
  judgedSessions: 0,
  probes: { sessions: 0, turns: 0, byReason: { 'temp-cwd': 0, 'non-interactive-1-step': 0, 'one-step-unknown': 0 } },
  outcomeSources: { events: 0, facets: 0, both: 0, disagree: 0, unclear: 0 },
  ledgerError: null,
  facetsError: null,
  phases: [],
  trends: [],
  models: [],
  delegations: emptyDelegations(),
  mechanical: { sessions: 0, heavyReads: 0, heavySteps: 0, unmeasured: 0, share: null },
  brief: null,
  frictions: [],
  cortex: { pushed: 0, pending: 0, lastError: null, lastAt: null },
  agents: [],
  advisor: { heavyTurns: 0, heavyBeforeWrite: 0, heavyAtCompletion: 0, lightTurns: 0, lightWithAdvisor: 0 },
  goals: [],
  goalsError: null,
  calibration: emptyCalibration(),
  calibrationError: null,
  proposals: [],
  findings: [],
  effects: [],
  updatedAt: null,
}


export const recordsOf = (view: Layout): TurnRecord[] => [...view.turns.values()].flat()

export const cut = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 120)

export async function expandHome($: EngineInterface, path: string): Promise<string> {
  if (!path.startsWith('~/')) return path
  const placed = placePath(
    { home: await $.env.get('HOME'), userProfile: await $.env.get('USERPROFILE'), configDir: await $.env.get('CLAUDE_CONFIG_DIR') },
    path,
  )
  if ('reason' in placed) throw new Error(placed.reason)

  return placed.path
}
