import { expect, test } from 'claude-code/testing'

import { bound, CLASSES, higher, pinned } from './route'

test('every class has one pair', () => {
  expect(CLASSES).toEqual({
    read: { model: 'haiku', effort: 'low' },
    build: { model: 'sonnet', effort: 'medium' },
    judge: { model: 'opus', effort: 'high' },
    critical: { model: 'opus', effort: 'xhigh' },
  })
})

test('higher takes the higher class, either way round', () => {
  expect(higher('read', 'judge')).toBe('judge')
  expect(higher('judge', 'read')).toBe('judge')
  expect(higher('critical', 'build')).toBe('critical')
  expect(higher('build', 'build')).toBe('build')
})

test('the agent type bounds the answer: Explore is capped at build, Plan floored at judge, nothing else moves', () => {
  expect(bound('critical', { subagent_type: 'Explore' })).toEqual({ cls: 'build', note: 'capped' })
  expect(bound('judge', { subagent_type: 'Explore' })).toEqual({ cls: 'build', note: 'capped' })
  expect(bound('read', { subagent_type: 'Explore' })).toEqual({ cls: 'read' })
  expect(bound('build', { subagent_type: 'Explore' })).toEqual({ cls: 'build' })
  expect(bound('read', { subagent_type: 'Plan' })).toEqual({ cls: 'judge', note: 'floored' })
  expect(bound('critical', { subagent_type: 'Plan' })).toEqual({ cls: 'critical' })
  expect(bound('read', { subagent_type: 'general-purpose' })).toEqual({ cls: 'read' })
  expect(bound('critical', {})).toEqual({ cls: 'critical' })
})

test('the bounds read the type only, never the words of the brief', () => {
  expect(bound('read', { description: 'Security audit of the guard', prompt: 'irreversible, critical' })).toEqual({ cls: 'read' })
})

test('a fork and a custom type are pinned, the engine\'s own types are not', () => {
  expect(pinned({ subagent_type: 'fork' })).toBe(true)
  expect(pinned({ subagent_type: 'zetetic:reviewer' })).toBe(true)
  expect(pinned({ subagent_type: 'Explore' })).toBe(false)
  expect(pinned({})).toBe(false)
})
