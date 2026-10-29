import { expect, test } from 'claude-code/testing'

import { brief, failureOf, fit, initialBudget, INSTRUCTIONS, LIMIT_TOKENS, parse } from './fm'

test('the budget leaves the response reserve and the safety margin, at the worst-case 2 characters per token', () => {
  // (8125 - 256 - 200) tokens * 2 characters - the instructions
  expect(initialBudget()).toBe((8125 - 256 - 200) * 2 - INSTRUCTIONS.length)
  expect(LIMIT_TOKENS).toBe(8125)
  // even at 2 characters per token the brief, the instructions and the reserves fit the measured limit
  expect((initialBudget() + INSTRUCTIONS.length) / 2 + 256 + 200).toBeLessThanOrEqual(LIMIT_TOKENS)
})

test('fit keeps a short text whole and cuts a long one to exactly the budget, two thirds head, one third tail', () => {
  expect(fit('abc', 10)).toBe('abc')
  const text = 'H'.repeat(1000) + 'T'.repeat(1000)
  const cut = fit(text, 300)
  expect(cut.length).toBe(300)
  expect(cut).toContain('[…]')
  expect(cut.startsWith('HHH')).toBe(true)
  expect(cut.endsWith('TTT')).toBe(true)
  const [head = '', tail = ''] = cut.split('\n[…]\n')
  expect(head.length).toBe(Math.floor(((300 - '\n[…]\n'.length) * 2) / 3))
  expect(head.length + tail.length + '\n[…]\n'.length).toBe(300)
})

test('the brief names the description, the type and the prompt', () => {
  expect(brief({ description: 'd', prompt: 'p' }, 1000)).toBe('description: d\nsubagent_type: general-purpose\nprompt: p')
})

test('only a JSON object with a known class parses', () => {
  expect(parse('{"class":"judge","reason":"r"}')).toEqual({ cls: 'judge', why: 'r' })
  expect(parse('{"reason":"r","class":"critical"}')).toEqual({ cls: 'critical', why: 'r' })
  expect(parse('{"class":"toString","reason":"r"}')).toBeNull()
  expect(parse('{"class":"other"}')).toBeNull()
  expect(parse('judge')).toBeNull()
  expect(parse('')).toBeNull()
})

test('a rejected process.run is told apart: cannot start, timeout, anything else', () => {
  expect(failureOf(new Error('HooksError: p: $.process.run(/usr/bin/fm) failed to start: ENOENT'))).toBe('fm-absent')
  expect(failureOf(new Error('HooksError: p: $.process.run(/usr/bin/fm) aborted: still running after 4000ms'))).toBe('fm-timeout')
  expect(failureOf(new TypeError("undefined is not an object (evaluating '$.process.run')"))).toBe('fm-absent')
  expect(failureOf(new Error('something else'))).toBe('fm-error')
})
