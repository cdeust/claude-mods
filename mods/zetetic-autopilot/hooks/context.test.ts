import { expect, test } from 'claude-code/testing'

import type { ContextHealth } from '../types'
import { band, crossed, matchThresholds, serversOf } from './context'

const FILE = JSON.stringify({
  models: [
    { match: 'fable', warn: 120000, hard: 160000 },
    { match: 'sonnet', warn: 180000, hard: 200000 },
  ],
  default: { warn: 180000, hard: 200000 },
})

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

test('thresholds match the model by substring, else the default, else nothing', () => {
  expect(matchThresholds(FILE, 'claude-fable-5-1')).toEqual({ warn: 120000, hard: 160000 })
  expect(matchThresholds(FILE, 'Sonnet 5.5')).toEqual({ warn: 180000, hard: 200000 })
  expect(matchThresholds(FILE, 'claude-opus-5-5')).toEqual({ warn: 180000, hard: 200000 })
  expect(() => matchThresholds('not json', 'x')).toThrow(/ctxguard-thresholds\.json is not valid JSON/)
})

test('bands follow the thresholds and unknown stays unknown', () => {
  expect(band(health(50000))).toBe('measured')
  expect(band(health(120000))).toBe('warn')
  expect(band(health(170000))).toBe('hard')
  expect(band(health(null))).toBe('unknown')
})

test('MCP tool schemas are summed per server, largest first', () => {
  const rows = serversOf([
    { serverName: 'cortex', tokens: 100 },
    { serverName: 'github', tokens: 900 },
    { serverName: 'cortex', tokens: 150 },
  ])
  expect(rows).toEqual([
    { server: 'github', tools: 1, tokens: 900 },
    { server: 'cortex', tools: 2, tokens: 250 },
  ])
})

test('crossings are transitions into a worse band', () => {
  expect(crossed(health(100000), health(125000))).toBe('warn')
  expect(crossed(health(125000), health(130000))).toBe(undefined)
  expect(crossed(health(125000), health(165000))).toBe('hard')
  expect(crossed(null, health(10))).toBe(undefined)
})
