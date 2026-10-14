// The state this viewer reads from the mods it depends on (plugin.json `dependencies`), typed
// by their contracts as the engine lays them: nothing is copied from another mod's folder.

import type { PluginState } from 'claude-code'

export type ContextHealth = NonNullable<PluginState['zetetic-autopilot']['context']>
export type PolicyState = PluginState['zetetic-autopilot']['policy']
export type PolicyDecision = PolicyState['decisions'][number]
export type GeniusState = PluginState['zetetic-genius']['state']
export type Refusal = PluginState['cortex-guard']['refusals'][number]
export type PhasesState = PluginState['zetetic-autopilot']['phases']
export type LoopPhases = PhasesState['loops'][number]
export type InsightsState = PluginState['zetetic-insights']['insights']

// A read of another mod's state that failed: a different condition from a value that is absent
// (a mod not loaded leaves it undefined), so it travels as its own case with the reason.
export type Unreadable = { error: string }
export const isUnreadable = (v: unknown): v is Unreadable =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && 'error' in v && typeof (v as Unreadable).error === 'string'
