import { expect, test } from 'claude-code/testing'

import { bound, CLASSES, guess, route } from './route'

const of = (subagent_type: string | undefined, description: string, prompt = '') => route({ subagent_type, description, prompt })

test('explore, web and search work runs on haiku at low effort', () => {
  expect(of('Explore', 'Find call sites')).toMatchObject({ model: 'haiku', effort: 'low' })
  expect(of('general-purpose', 'Crawl the docs site')).toMatchObject({ model: 'haiku', effort: 'low' })
  expect(of('general-purpose', 'Recherche web sur les mods')).toMatchObject({ model: 'haiku', effort: 'low' })
  expect(of(undefined, 'Search the repo for X')).toMatchObject({ model: 'haiku', effort: 'low' })
})

test('an exploration is read, whatever its thoroughness: one class, one pair', () => {
  expect(of('Explore', 'Map the repo', 'very thorough')).toMatchObject({ model: 'haiku', effort: 'low' })
})

test('measurement and experiment are judgment, not lookup', () => {
  expect(of('general-purpose', 'Measure the classifier latency')).toMatchObject({ model: 'opus', effort: 'high' })
  expect(of('general-purpose', 'Experiment with greedy decoding')).toMatchObject({ model: 'opus', effort: 'high' })
})

test('bound: Explore is capped at build, Plan floored at judge, a judge keyword is a floor, nothing else moves', () => {
  expect(bound('critical', { subagent_type: 'Explore', description: 'Find it' })).toEqual({ cls: 'build', note: 'fm-capped' })
  expect(bound('read', { subagent_type: 'Explore', description: 'Find it' })).toEqual({ cls: 'read' })
  expect(bound('read', { subagent_type: 'Plan', description: 'x' })).toEqual({ cls: 'judge', note: 'fm-floored' })
  expect(bound('read', { description: 'Security audit' })).toEqual({ cls: 'judge', note: 'fm-floored' })
  expect(bound('build', { description: 'Irreversible migration' })).toEqual({ cls: 'critical', note: 'fm-floored' })
  expect(bound('critical', { description: 'Review it' })).toEqual({ cls: 'critical' })
  expect(bound('read', { description: 'Implement it' })).toEqual({ cls: 'read' })
  expect(bound('critical', { description: 'Do the thing' })).toEqual({ cls: 'critical' })
})

test('every class has one pair, and an irreversible brief is critical for the regex too', () => {
  expect(CLASSES).toEqual({
    read: { model: 'haiku', effort: 'low' },
    build: { model: 'sonnet', effort: 'medium' },
    judge: { model: 'opus', effort: 'high' },
    critical: { model: 'opus', effort: 'xhigh' },
  })
  expect(guess({ description: 'Irreversible production migration' }).cls).toBe('critical')
  expect(guess({ description: 'Review the design' }).cls).toBe('judge')
})

test('the default is tagged default, a keyword hit regex', () => {
  expect(guess({ description: 'Do the thing' }).by).toBe('default')
  expect(guess({ description: 'Fix the bug' }).by).toBe('regex')
})

test('implementation runs on sonnet, judgment on opus', () => {
  expect(of('general-purpose', 'Implement the guard')).toMatchObject({ model: 'sonnet', effort: 'medium' })
  expect(of('general-purpose', 'Corrige le bug de route')).toMatchObject({ model: 'sonnet', effort: 'medium' })
  expect(of('general-purpose', 'Security review of the hook')).toMatchObject({ model: 'opus', effort: 'high' })
  expect(of('Plan', 'Anything')).toMatchObject({ model: 'opus', effort: 'high' })
})

test('building outranks reading, judgment outranks building', () => {
  expect(of('general-purpose', 'Search and fix the bug')).toMatchObject({ model: 'sonnet' })
  expect(of('general-purpose', 'Review the search fix')).toMatchObject({ model: 'opus' })
})

test('a fork and a custom type are left alone', () => {
  expect(of('fork', 'Anything')).toBeNull()
  expect(of('zetetic:reviewer', 'Review it')).toBeNull()
})

test('an unclassified task is sonnet at medium, not haiku', () => {
  expect(of('general-purpose', 'Do the thing')).toMatchObject({ model: 'sonnet', effort: 'medium' })
})
