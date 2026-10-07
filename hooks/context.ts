import type { ContextHealth } from '../types'

// source: ~/.claude/ctxguard-thresholds.json, the file stop-context-guard.py (zetetic
// plugin) reads: first substring match on the lowercased model wins, else `default`.
export const THRESHOLDS_PATH = '~/.claude/ctxguard-thresholds.json'

export type Thresholds = { warn: number; hard: number }

type ThresholdsFile = {
  models?: { match: string; warn: number; hard: number }[]
  default?: Thresholds
}

export const matchThresholds = (fileText: string, model: string): Thresholds | undefined => {
  let parsed: ThresholdsFile
  try {
    parsed = JSON.parse(fileText) as ThresholdsFile
  } catch {
    return undefined
  }
  const m = model.toLowerCase()
  const hit = (parsed.models ?? []).find((row) => m.includes(row.match.toLowerCase()))
  return hit === undefined ? parsed.default : { warn: hit.warn, hard: hit.hard }
}

export type Band = 'measured' | 'warn' | 'hard' | 'unknown'

export const band = (c: ContextHealth): Band => {
  if (c.tokens === null) return 'unknown'
  if (c.hard !== null && c.tokens >= c.hard) return 'hard'
  if (c.warn !== null && c.tokens >= c.warn) return 'warn'
  return 'measured'
}

// A bar of `width` cells: the fill, and where the warn and hard marks fall.
export const bar = (c: ContextHealth, width: number): string => {
  const cell = (n: number | null) =>
    n === null ? -1 : Math.min(width - 1, Math.round((n / c.window) * width))
  const fill = c.tokens === null ? 0 : Math.round((c.tokens / c.window) * width)
  const warnAt = cell(c.warn)
  const hardAt = cell(c.hard)
  let out = ''
  for (let i = 0; i < width; i++) {
    if (i === hardAt) out += '┃'
    else if (i === warnAt) out += '│'
    else out += i < fill ? '█' : '·'
  }
  return out
}

// MCP tool schemas grouped by server, largest first: what each server costs on every request.
export const serversOf = (
  tools: readonly { serverName: string; tokens: number }[],
): { server: string; tools: number; tokens: number }[] => {
  const by = new Map<string, { tools: number; tokens: number }>()
  for (const t of tools) {
    const row = by.get(t.serverName) ?? { tools: 0, tokens: 0 }
    by.set(t.serverName, { tools: row.tools + 1, tokens: row.tokens + t.tokens })
  }
  return [...by.entries()]
    .map(([server, row]) => ({ server, ...row }))
    .sort((a, b) => b.tokens - a.tokens)
}

export const tokensLeft = (c: ContextHealth): { toWarn: number | null; toHard: number | null } => ({
  toWarn: c.tokens === null || c.warn === null ? null : c.warn - c.tokens,
  toHard: c.tokens === null || c.hard === null ? null : c.hard - c.tokens,
})

// A crossing is a transition into a worse band; the same band again says nothing.
export const crossed = (before: ContextHealth | null, after: ContextHealth): Band | undefined => {
  const b = after.tokens === null ? 'unknown' : band(after)
  const a = before === null ? 'measured' : band(before)
  const rank: Record<Band, number> = { unknown: 0, measured: 0, warn: 1, hard: 2 }
  return rank[b] > rank[a] ? b : undefined
}
