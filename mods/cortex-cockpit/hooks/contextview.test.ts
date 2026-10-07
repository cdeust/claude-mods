import { expect, test } from 'claude-code/testing'

import { bar, tokensLeft } from './contextview'
import type { ContextHealth } from './deps'

const health = (tokens: number | null, warn = 120000, hard = 160000): ContextHealth => ({
  tokens,
  window: 200000,
  percent: tokens === null ? null : Math.round((tokens / 200000) * 100),
  model: 'claude-fable-5-1',
  warn,
  hard,
  thresholdsSource: 'test',
  rateLimits: [],
  usd: null,
  categories: [],
  mcpServers: [],
  band: 'measured',
  readAt: 0,
})

test('the bar marks warn and hard and fills to the tokens', () => {
  const b = bar(health(100000), 20)
  expect(b.length).toBe(20)
  expect(b.slice(0, 10)).toBe('██████████')
  expect(b[12]).toBe('│')
  expect(b[16]).toBe('┃')
})

test('distance to the thresholds', () => {
  expect(tokensLeft(health(100000))).toEqual({ toWarn: 20000, toHard: 60000 })
  expect(tokensLeft(health(null))).toEqual({ toWarn: null, toHard: null })
})
