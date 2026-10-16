// The context window as the engine measures it, with the Stop guard's checkpoint thresholds beside it.

import type { EngineInterface } from 'claude-code'

import type { ContextHealth } from '../types'
import { THRESHOLDS_PATH, band, matchThresholds, serversOf } from './context'
import { expandHome } from './definitions'

export type Measured = {
  context: {
    tokens?: number
    window: number
    percent?: number
    breakdown?: {
      categories: readonly { name: string; tokens: number }[]
      mcpTools: readonly { serverName: string; tokens: number }[]
    }
  }
  rateLimits: readonly { kind: string; percentUsed: number }[]
  cost?: { usd: number }
}

// A measure carries no breakdown; the one read before is kept until the next full read.
export async function readContext($: EngineInterface, m: Measured, before: ContextHealth | null): Promise<ContextHealth> {
  const model = await $.session.model()
  let warn: number | null = null
  let hard: number | null = null
  let source = THRESHOLDS_PATH
  try {
    const t = matchThresholds(await $.fs.read(await expandHome($, THRESHOLDS_PATH)), model)
    if (t !== undefined) {
      warn = t.warn
      hard = t.hard
    } else source = `${THRESHOLDS_PATH} has no match for ${model}`
  } catch (error) {
    // The file is the Stop guard's. A refusal, a missing file and a file that is not JSON all leave
    // no thresholds; the viewer is told which, with the reason, instead of reading all three as absent.
    source = `${THRESHOLDS_PATH} unreadable: ${(error instanceof Error ? error.message : String(error)).slice(0, 100)}`
  }
  const reading = { tokens: m.context.tokens ?? null, warn, hard }
  return {
    ...reading,
    window: m.context.window,
    percent: m.context.percent ?? null,
    model,
    thresholdsSource: source,
    rateLimits: m.rateLimits.map((r) => ({ kind: r.kind, percentUsed: r.percentUsed })),
    usd: m.cost?.usd ?? null,
    categories:
      m.context.breakdown?.categories.map((c) => ({ name: c.name, tokens: c.tokens })) ?? before?.categories ?? [],
    mcpServers: m.context.breakdown === undefined ? (before?.mcpServers ?? []) : serversOf(m.context.breakdown.mcpTools),
    band: band(reading),
    readAt: await $.clock.now(),
  }
}

