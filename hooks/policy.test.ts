import { expect, test } from 'claude-code/testing'

import { agentModelFor, defaultEffort, effortFor, leanText, pressureOf } from './policy'

test('the default effort follows model-behavior.md', () => {
  expect(defaultEffort('claude-fable-5-1')).toBe('high')
  expect(defaultEffort('claude-opus-5-5')).toBe('medium')
  expect(defaultEffort('Sonnet 5.5')).toBe('medium')
})

test('the ladder keeps the first request, lowers the loop, never raises', () => {
  expect(effortFor('claude-fable-5-1', 0, undefined, 'none')).toBe(undefined)
  expect(effortFor('claude-fable-5-1', 0, 'xhigh', 'none')).toBe(undefined)
  expect(effortFor('claude-fable-5-1', 1, undefined, 'none')).toBe('medium')
  expect(effortFor('claude-fable-5-1', 3, 'high', 'none')).toBe('medium')
  expect(effortFor('claude-fable-5-1', 3, 'low', 'none')).toBe(undefined)
  expect(effortFor('claude-opus-5-5', 2, undefined, 'none')).toBe(undefined)
})

test('pressure lowers the loop to low and the first request one notch at most', () => {
  expect(effortFor('claude-fable-5-1', 0, 'high', 'quota')).toBe('medium')
  expect(effortFor('claude-fable-5-1', 0, 'medium', 'quota')).toBe(undefined)
  expect(effortFor('claude-fable-5-1', 1, 'high', 'quota')).toBe('low')
  expect(effortFor('claude-sonnet-5-5', 4, 'medium', 'context')).toBe('low')
  expect(effortFor('claude-sonnet-5-5', 4, 'low', 'context')).toBe(undefined)
})

test('a classified base replaces the session setting as the rung the ladder starts from', () => {
  // routine on Fable: the first request drops to low and the loop stays there
  expect(effortFor('claude-fable-5-1', 0, 'high', 'none', 'low')).toBe('low')
  expect(effortFor('claude-fable-5-1', 2, 'high', 'none', 'low')).toBe('low')
  // critical keeps high on the first request, the loop still runs at medium
  expect(effortFor('claude-fable-5-1', 0, 'high', 'none', 'high')).toBe(undefined)
  expect(effortFor('claude-fable-5-1', 1, 'high', 'none', 'high')).toBe('medium')
  // a base above the session setting raises the first request (Sonnet at medium, critical)
  expect(effortFor('claude-sonnet-5-5', 0, 'medium', 'none', 'high')).toBe('high')
  // pressure still caps the classified base
  expect(effortFor('claude-fable-5-1', 0, 'high', 'quota', 'high')).toBe('medium')
})

test('pressure comes from the five-hour window first, then the context band', () => {
  expect(pressureOf([{ kind: 'five_hour', percentUsed: 85 }], 80, 'measured')).toBe('quota')
  expect(pressureOf([{ kind: 'five_hour', percentUsed: 40 }], 80, 'warn')).toBe('context')
  expect(pressureOf([{ kind: 'seven_day', percentUsed: 90 }], 80, 'measured')).toBe('none')
  expect(pressureOf([], 80, 'unknown')).toBe('none')
})

test('subagents go one notch down under pressure only', () => {
  expect(agentModelFor('opus', 'claude-fable-5-1', 'quota')).toBe('sonnet')
  expect(agentModelFor(undefined, 'claude-fable-5-1', 'context')).toBe('sonnet')
  expect(agentModelFor('sonnet', 'claude-fable-5-1', 'quota')).toBe(undefined)
  expect(agentModelFor('haiku', 'claude-opus-5-5', 'quota')).toBe(undefined)
  expect(agentModelFor('opus', 'claude-fable-5-1', 'none')).toBe(undefined)
})

test('a long result keeps its head and tail and names the cut', () => {
  const text = 'A'.repeat(1000) + 'B'.repeat(1000) + 'C'.repeat(1000)
  const lean = leanText(text, 1000)
  expect(lean).toBeDefined()
  expect(lean?.text.startsWith('A'.repeat(600))).toBe(true)
  expect(lean?.text.endsWith('C'.repeat(250))).toBe(true)
  expect(lean?.cut).toBe(3000 - 600 - 250)
  expect(lean?.text).toContain('cortex-cockpit cut 2150 characters')
  expect(leanText('short', 1000)).toBe(undefined)
})
