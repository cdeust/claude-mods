import type { CortexEntry, CortexStats, TurnTally } from '../types'

// Pure functions: no engine access, so the test file exercises them directly.

// source: the Cortex plugin exposes its tools to the model as
// mcp__plugin_hypermnesia-mcp_cortex__<tool> (seen in this build's tool list).
const CORTEX_PREFIX = 'mcp__plugin_hypermnesia-mcp_cortex__'
const STATS_KEYS = ['total_memories', 'avg_heat', 'grooming_staleness'] as const

export const isCortexTool = (tool: string): boolean => tool.startsWith(CORTEX_PREFIX)

export const shortTool = (tool: string): string =>
  isCortexTool(tool) ? tool.slice(CORTEX_PREFIX.length) : tool

// Exact counts, thousands grouped by a space: "119 304" (gate G10).
export const group = (n: number): string =>
  String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

export const emptyTally = (): TurnTally => ({
  turns: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  tools: {},
})

export const begin = (id: string, tool: string, now: number): CortexEntry => ({
  id,
  tool: shortTool(tool),
  startedAt: now,
  status: 'pending',
})

// recall answers {"count": n, "receipt_id": m, ...}; absent means we say so, not 0.
const numberAfter = (text: string, key: string): number | undefined => {
  const hit = new RegExp(`"${key}"\\s*:\\s*(\\d+)`).exec(text)
  return hit === null ? undefined : Number(hit[1])
}

export const finish = (
  entry: CortexEntry,
  now: number,
  text: string,
  isError: boolean,
): CortexEntry => ({
  ...entry,
  status: isError ? 'blocked' : 'measured',
  ms: Math.max(0, now - entry.startedAt),
  count: numberAfter(text, 'count'),
  receipt: numberAfter(text, 'receipt_id'),
})

export const countBy = (ledger: readonly CortexEntry[]): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const one of ledger) out[one.tool] = (out[one.tool] ?? 0) + 1
  return out
}

type Block = { type: string; text?: string }
export type StatsParse = { stats: CortexStats } | { error: string }

export const parseStats = (
  result: { content: readonly Block[]; isError: boolean; structuredContent?: unknown },
  now: number,
): StatsParse => {
  const first = result.content.find((b) => b.type === 'text')?.text ?? ''
  if (result.isError) return { error: first.slice(0, 160) || 'server reported an error' }
  let raw: unknown = result.structuredContent
  if (raw === undefined) {
    try {
      raw = JSON.parse(first)
    } catch {
      return { error: 'memory_stats did not return JSON' }
    }
  }
  const obj = raw as Record<string, unknown> | null
  const missing = STATS_KEYS.filter((k) => obj === null || typeof obj !== 'object' || !(k in obj))
  if (missing.length > 0) return { error: `memory_stats lacks ${missing.join(', ')}` }
  return { stats: { ...(obj as Omit<CortexStats, 'readAt'>), readAt: now } }
}

// Heat track of `width` cells: how many are filled and each cell's rung 0..3.
export const heatCells = (value: number, width: number) => {
  const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  const filled = Math.round(v * width)
  return Array.from({ length: width }, (_, i) => ({
    isFilled: i < filled,
    rung: Math.min(3, Math.floor((i / width) * 4)),
  }))
}

export const ageLabel = (ms: number): string => {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

// Share of input served from the prompt cache; undefined when nothing was read.
export const cacheShare = (t: TurnTally): number | undefined => {
  const all = t.input + t.cacheRead + t.cacheWrite
  return all === 0 ? undefined : t.cacheRead / all
}
