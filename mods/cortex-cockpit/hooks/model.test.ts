import { expect, test } from 'claude-code/testing'

import {
  begin,
  cacheShare,
  countBy,
  emptyTally,
  finish,
  group,
  heatCells,
  isCortexTool,
  parseStats,
  shortTool,
} from './model'

const stats = {
  total_memories: 119304,
  avg_heat: 0.4321,
  grooming_staleness: {},
}

test('groups digits exactly, no rounding', () => {
  expect(group(119304)).toBe('119 304')
  expect(group(7)).toBe('7')
  expect(group(1000)).toBe('1 000')
})

test('recognises Cortex tools and shortens them', () => {
  const t = 'mcp__plugin_hypermnesia-mcp_cortex__recall'
  expect(isCortexTool(t)).toBe(true)
  expect(shortTool(t)).toBe('recall')
  expect(isCortexTool('Bash')).toBe(false)
  expect(shortTool('Bash')).toBe('Bash')
})

test('a finished call is measured with count and receipt, or blocked on error', () => {
  const e = begin('1', 'mcp__plugin_hypermnesia-mcp_cortex__recall', 1000)
  const ok = finish(e, 1250, '{"memories":[],"count":10,"receipt_id": 42}', false)
  expect(ok).toEqual({ ...e, status: 'measured', ms: 250, count: 10, receipt: 42 })
  const bad = finish(e, 1100, 'boom', true)
  expect(bad.status).toBe('blocked')
  expect(bad.count).toBe(undefined)
})

test('countBy tallies by short name', () => {
  const a = begin('1', 'mcp__plugin_hypermnesia-mcp_cortex__recall', 0)
  const b = begin('2', 'mcp__plugin_hypermnesia-mcp_cortex__remember', 0)
  expect(countBy([a, a, b])).toEqual({ recall: 2, remember: 1 })
})

test('parseStats accepts JSON text and structured content, rejects the rest', () => {
  const text = [{ type: 'text', text: JSON.stringify(stats) }]
  const viaText = parseStats({ content: text, isError: false }, 5)
  expect('stats' in viaText && viaText.stats.total_memories).toBe(119304)
  const viaStructured = parseStats({ content: [], isError: false, structuredContent: stats }, 5)
  expect('stats' in viaStructured).toBe(true)
  expect(parseStats({ content: [{ type: 'text', text: 'nope' }], isError: true }, 5)).toEqual({
    error: 'nope',
  })
  const partial = parseStats(
    { content: [{ type: 'text', text: '{"avg_heat":1}' }], isError: false },
    5,
  )
  expect('error' in partial && partial.error).toContain('total_memories')
})

test('heat track: zero is an empty track, one is full', () => {
  expect(heatCells(0, 8).some((c) => c.isFilled)).toBe(false)
  expect(heatCells(1, 8).every((c) => c.isFilled)).toBe(true)
  expect(heatCells(0.5, 8).filter((c) => c.isFilled).length).toBe(4)
  expect(heatCells(Number.NaN, 4).length).toBe(4)
})

test('cache share is undefined with no input, exact otherwise', () => {
  expect(cacheShare(emptyTally())).toBe(undefined)
  expect(cacheShare({ ...emptyTally(), input: 100, cacheRead: 300 })).toBe(0.75)
})

import { inputGist, outputText, parseRecall, SHOWN_HITS } from './recall'

const recallJson = (n: number) =>
  JSON.stringify({
    memories: Array.from({ length: n }, (_, i) => ({
      memory_id: String(i),
      content: `memory   number\n${i}`,
      score: 0.9,
      heat: 1,
      domain: 'cortex',
      source: 'lesson',
    })),
    count: n,
    receipt_id: 7,
    intent: 'general',
    low_signal_dropped: 18,
  })

test('parseRecall keeps exact counts, shows a bounded list and says what is hidden', () => {
  const view = parseRecall(recallJson(8))
  expect(view?.count).toBe(8)
  expect(view?.receipt).toBe(7)
  expect(view?.dropped).toBe(18)
  expect(view?.shown.length).toBe(SHOWN_HITS)
  expect(view?.hidden).toBe(3)
  expect(view?.shown[0]?.content).toBe('memory number 0')
})

test('parseRecall refuses what is not a recall result', () => {
  expect(parseRecall('not json')).toBe(undefined)
  expect(parseRecall('{"total_memories":3}')).toBe(undefined)
  expect(parseRecall('null')).toBe(undefined)
})

test('outputText reads strings, MCP content blocks and plain objects', () => {
  expect(outputText('x')).toBe('x')
  expect(
    outputText({
      content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }],
    }),
  ).toBe('a\nb')
  expect(outputText({ n: 1 })).toBe('{"n":1}')
  expect(outputText(undefined)).toBe('')
})

test('inputGist picks the first informative field and cuts long text', () => {
  expect(inputGist({ query: 'hello', domain: 'd' })).toBe('hello')
  expect(inputGist({ domain: 'd' })).toBe('d')
  expect(inputGist({ query: 'x'.repeat(200) }).length).toBe(80)
  expect(inputGist(undefined)).toBe('')
})
