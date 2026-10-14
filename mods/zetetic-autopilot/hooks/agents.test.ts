import { expect, test } from 'claude-code/testing'

import { ancestors, definitionPaths, parseDefinition, pinnedModel } from './agents'

const INSTALLED = JSON.stringify({
  version: 2,
  plugins: {
    'zetetic-team-subagents@zetetic-marketplace': [{ installPath: '/c/zetetic/2.44.0' }],
    'superpowers@claude-mods': [{ installPath: '/c/superpowers/7.0.0' }],
  },
})

test("a plugin type's definition is its plugin's agents/<name>.md", () => {
  expect(definitionPaths('zetetic-team-subagents:advisor', INSTALLED, '/h/.claude', '/r', ['/r'])).toEqual([
    '/c/zetetic/2.44.0/agents/advisor.md',
  ])
  expect(definitionPaths('zetetic-team-subagents:genius:feynman', INSTALLED, '/h/.claude', '/r', ['/r'])).toEqual([
    '/c/zetetic/2.44.0/agents/genius/feynman.md',
  ])
  expect(definitionPaths('nowhere:agent', INSTALLED, '/h/.claude', '/r', ['/r'])).toEqual([])
  expect(definitionPaths('zetetic-team-subagents:advisor', undefined, '/h/.claude', '/r', ['/r'])).toEqual([])
})

test("a bare type is looked for in the project's agents, then the user's", () => {
  expect(definitionPaths('dispatch', undefined, '/h/.claude', '/r', ['/r'])).toEqual([
    '/r/.claude/agents/dispatch.md',
    '/h/.claude/agents/dispatch.md',
  ])
})

test('an installed-plugins record that is not JSON says so', () => {
  expect(() => definitionPaths('a:b', '{nope', '/h/.claude', '/r', ['/r'])).toThrow(/not valid JSON/)
})

test('the frontmatter model and effort are read, quoted or not; a body line is not frontmatter', () => {
  expect(parseDefinition('---\nname: advisor\nmodel: fable\neffort: high\n---\nmodel: opus\n')).toEqual({
    model: 'fable',
    effort: 'high',
  })
  expect(parseDefinition('---\nmodel: "haiku"\n---\n')).toEqual({ model: 'haiku' })
  expect(parseDefinition('---\nmodel:\ntools: Read\neffort:\n---\n')).toEqual({})
  expect(parseDefinition('no frontmatter\nmodel: opus\n')).toEqual({})
})

test('inherit and an absent model line pin nothing', () => {
  expect(pinnedModel({ model: 'inherit' })).toBe(undefined)
  expect(pinnedModel({})).toBe(undefined)
  expect(pinnedModel({ model: 'opus' })).toBe('opus')
})

const entry = (scope: string, installPath: string, projectPath?: string) => ({ scope, installPath, ...(projectPath === undefined ? {} : { projectPath }) })
const installedWith = (...installs: object[]) => JSON.stringify({ plugins: { 'p@m': installs } })
const pathsFor = (json: string, cwd: string) => definitionPaths('p:a', json, '/h/.claude', cwd, [cwd])

test("the install that runs is the one whose scope covers the session's project, not the first listed", () => {
  const json = installedWith(entry('project', '/c/p/other', '/elsewhere'), entry('user', '/c/p/user'), entry('project', '/c/p/here', '/work/repo'))
  // project beats user inside its folder (also from a subdirectory); another project's entry never applies
  expect(pathsFor(json, '/work/repo')).toEqual(['/c/p/here/agents/a.md'])
  expect(pathsFor(json, '/work/repo/pkg/x')).toEqual(['/c/p/here/agents/a.md'])
  expect(pathsFor(json, '/somewhere/else')).toEqual(['/c/p/user/agents/a.md'])
  expect(pathsFor(installedWith(entry('project', '/c/p/other', '/elsewhere')), '/work/repo')).toEqual([])
})

test("a local entry beats a project entry, which beats the user's; a scopeless entry is the user's", () => {
  const json = installedWith({ installPath: '/c/p/bare' }, entry('project', '/c/p/project', '/w'), entry('local', '/c/p/local', '/w'))
  expect(pathsFor(json, '/w')).toEqual(['/c/p/local/agents/a.md'])
  expect(pathsFor(json, '/v')).toEqual(['/c/p/bare/agents/a.md'])
})

test('a project folder matches whole path components, in a POSIX or a Windows spelling', () => {
  const json = installedWith(entry('project', '/c/p/here', '/work/repo'), entry('user', '/c/p/user'))
  expect(pathsFor(json, '/work/repo-two')).toEqual(['/c/p/user/agents/a.md'])
  const win = installedWith(entry('project', 'C:\\p\\here', 'C:\\work\\repo'), entry('user', 'C:\\p\\user'))
  expect(pathsFor(win, 'C:\\work\\repo\\pkg')).toEqual(['C:\\p\\here/agents/a.md'])
})

test('the folders from the working directory up, nearest first', () => {
  expect(ancestors('/r/pkg/deep')).toEqual(['/r/pkg/deep', '/r/pkg', '/r', '/'])
  expect(ancestors('C:\\r\\pkg')).toEqual(['C:\\r\\pkg', 'C:\\r', 'C:'])
  expect(ancestors('/')).toEqual(['/'])
})

test("a bare type is looked for in every project folder given, nearest first, then the user's", () => {
  expect(definitionPaths('dispatch', undefined, '/h/.claude', '/r/pkg', ['/r/pkg', '/r'])).toEqual([
    '/r/pkg/.claude/agents/dispatch.md',
    '/r/.claude/agents/dispatch.md',
    '/h/.claude/agents/dispatch.md',
  ])
})
