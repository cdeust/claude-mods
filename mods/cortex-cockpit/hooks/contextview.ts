// Display-only readings of the context window the autopilot measures.

import type { ContextHealth } from './deps'

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

export const tokensLeft = (c: ContextHealth): { toWarn: number | null; toHard: number | null } => ({
  toWarn: c.tokens === null || c.warn === null ? null : c.warn - c.tokens,
  toHard: c.tokens === null || c.hard === null ? null : c.hard - c.tokens,
})
