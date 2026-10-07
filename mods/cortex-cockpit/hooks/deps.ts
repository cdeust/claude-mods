// The state this viewer reads from the mods it depends on (plugin.json `dependencies`), typed
// by their contracts as the engine lays them: nothing is copied from another mod's folder.

import type { PluginState } from 'claude-code'

export type ContextHealth = NonNullable<PluginState['zetetic-autopilot']['context']>
export type PolicyState = PluginState['zetetic-autopilot']['policy']
export type PolicyDecision = PolicyState['decisions'][number]
export type GeniusState = PluginState['zetetic-genius']['state']
export type Refusal = PluginState['cortex-guard']['refusals'][number]
