import { expect, test } from 'claude-code/testing'

import { definitionPaths, parseDefinition, pinnedModel } from './agents'

const INSTALLED = JSON.stringify({
  version: 2,
  plugins: {
    'zetetic-team-subagents@zetetic-marketplace': [{ installPath: '/c/zetetic/2.44.0' }],
    'superpowers@claude-mods': [{ installPath: '/c/superpowers/7.0.0' }],
  },
})

test("a plugin type's definition is its plugin's agents/<name>.md", () => {
  expect(definitionPaths('zetetic-team-subagents:advisor', INSTALLED, '/h/.claude', '/r')).toEqual([
    '/c/zetetic/2.44.0/agents/advisor.md',
  ])
  expect(definitionPaths('nowhere:agent', INSTALLED, '/h/.claude', '/r')).toEqual([])
  expect(definitionPaths('zetetic-team-subagents:advisor', undefined, '/h/.claude', '/r')).toEqual([])
})

test("a bare type is looked for in the project's agents, then the user's", () => {
  expect(definitionPaths('dispatch', undefined, '/h/.claude', '/r')).toEqual([
    '/r/.claude/agents/dispatch.md',
    '/h/.claude/agents/dispatch.md',
  ])
})

test('an installed-plugins record that is not JSON says so', () => {
  expect(() => definitionPaths('a:b', '{nope', '/h/.claude', '/r')).toThrow(/not valid JSON/)
})

test('the frontmatter model and effort are read, quoted or not; a body line is not frontmatter', () => {
  expect(parseDefinition('---\nname: advisor\nmodel: fable\neffort: high\n---\nmodel: opus\n')).toEqual({
    model: 'fable',
    effort: 'high',
  })
  expect(parseDefinition('---\nmodel: "haiku"\n---\n')).toEqual({ model: 'haiku' })
  expect(parseDefinition('no frontmatter\nmodel: opus\n')).toEqual({})
})

test('inherit and an absent model line pin nothing', () => {
  expect(pinnedModel({ model: 'inherit' })).toBe(undefined)
  expect(pinnedModel({})).toBe(undefined)
  expect(pinnedModel({ model: 'opus' })).toBe('opus')
})
