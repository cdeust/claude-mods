import { expect, test } from 'claude-code/testing'

import { route } from './route'

const of = (subagent_type: string | undefined, description: string, prompt = '') => route({ subagent_type, description, prompt })

test('explore, web and search work runs on haiku at low effort', () => {
  expect(of('Explore', 'Find call sites')).toMatchObject({ model: 'haiku', effort: 'low' })
  expect(of('general-purpose', 'Crawl the docs site')).toMatchObject({ model: 'haiku', effort: 'low' })
  expect(of('general-purpose', 'Recherche web sur les mods')).toMatchObject({ model: 'haiku', effort: 'low' })
  expect(of(undefined, 'Search the repo for X')).toMatchObject({ model: 'haiku', effort: 'low' })
})

test('a very thorough exploration gets medium effort, still haiku', () => {
  expect(of('Explore', 'Map the repo', 'very thorough')).toMatchObject({ model: 'haiku', effort: 'medium' })
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
