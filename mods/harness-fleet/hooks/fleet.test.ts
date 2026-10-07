import { expect, test } from 'claude-code/testing'

import {
  ciOf,
  fleetRows,
  isBehind,
  parseInstalled,
  parseIssueCount,
  parseMarketplaces,
  parseOffered,
  parsePrList,
  repoOfRemote,
  reviewPrompt,
} from './fleet'

const INSTALLED = JSON.stringify({
  plugins: {
    'hypermnesia-mcp@cortex-plugins': [{ version: '4.23.4', installPath: '/c/4.23.4' }],
    'hypermnesia-mcp-viz@cortex-plugins': [{ version: '3.2.0' }],
    'ai-architect-mcp-spec@spec-marketplace': [{ version: '0.8.0' }],
    'superpowers@superpowers-marketplace': [{ version: '6.3.0' }],
  },
})
const MARKETPLACES = JSON.stringify({
  'cortex-plugins': { source: { source: 'github', repo: 'cdeust/cortex' }, installLocation: '/m/cortex', lastUpdated: '2026-09-22T22:53:29Z' },
  'spec-marketplace': { source: { source: 'directory', path: '/dev/spec' }, installLocation: '/dev/spec' },
  'superpowers-marketplace': { source: { source: 'github', repo: 'obra/superpowers-marketplace' }, installLocation: '/m/sp' },
})
const CORTEX_MANIFEST = JSON.stringify({
  plugins: [
    { name: 'hypermnesia-mcp', version: '4.24.0' },
    { name: 'hypermnesia-mcp-viz', version: '3.2.0' },
  ],
})

test('the engine records become installed plugins and marketplaces', () => {
  const installed = parseInstalled(INSTALLED)
  expect(installed.length).toBe(4)
  expect(installed[0]).toEqual({ name: 'hypermnesia-mcp', marketplace: 'cortex-plugins', version: '4.23.4' })
  const m = parseMarketplaces(MARKETPLACES)
  expect(m.find((x) => x.name === 'cortex-plugins')?.repo).toBe('cdeust/cortex')
  expect(m.find((x) => x.name === 'spec-marketplace')?.path).toBe('/dev/spec')
  expect(parseOffered(CORTEX_MANIFEST)).toEqual({ 'hypermnesia-mcp': '4.24.0', 'hypermnesia-mcp-viz': '3.2.0' })
})

test('versions compare field by field', () => {
  expect(isBehind('4.23.4', '4.24.0')).toBe(true)
  expect(isBehind('3.2.0', '3.2.0')).toBe(false)
  expect(isBehind('2.41.0', '2.9.0')).toBe(false)
  expect(isBehind('1.0.0', null)).toBe(false)
})

test('only the owner\'s marketplaces and local directories make the fleet, grouped by marketplace', () => {
  const rows = fleetRows(parseInstalled(INSTALLED), parseMarketplaces(MARKETPLACES), { 'cortex-plugins': parseOffered(CORTEX_MANIFEST) }, 'cdeust')
  expect(rows.map((r) => r.marketplace)).toEqual(['cortex-plugins', 'spec-marketplace'])
  const cortex = rows[0]
  expect(cortex?.repo).toBe('cdeust/cortex')
  expect(cortex?.plugins.map((p) => `${p.name}:${p.isBehind}`)).toEqual(['hypermnesia-mcp:true', 'hypermnesia-mcp-viz:false'])
  expect(rows[1]?.local).toBe('/dev/spec')
  expect(rows[1]?.plugins[0]?.offered).toBe(null)
})

test('a GitHub remote url yields owner/name', () => {
  expect(repoOfRemote('https://github.com/cdeust/ai-architect-mcp-spec.git\n')).toBe('cdeust/ai-architect-mcp-spec')
  expect(repoOfRemote('git@github.com:cdeust/Cortex.git')).toBe('cdeust/Cortex')
  expect(repoOfRemote('https://gitlab.com/x/y.git')).toBe(null)
})

// Shapes read on cdeust/Cortex PRs #670, #669, #651 (2026-10-08).
test('CI reads failure over anything, pending while a run is open, success only from green checks', () => {
  const run = (conclusion: string | null, status = 'COMPLETED') => ({ __typename: 'CheckRun', status, conclusion })
  expect(ciOf([])).toBe('none')
  expect(ciOf([run('SUCCESS'), run('SKIPPED'), run('NEUTRAL')])).toBe('success')
  expect(ciOf([run('SUCCESS'), run('CANCELLED')])).toBe('failure')
  expect(ciOf([run('SUCCESS'), run('FAILURE')])).toBe('failure')
  expect(ciOf([run('SUCCESS'), run(null, 'IN_PROGRESS')])).toBe('pending')
  expect(ciOf([run('SKIPPED')])).toBe('none')
  expect(ciOf([{ __typename: 'StatusContext', state: 'PENDING' }, run('SUCCESS')])).toBe('pending')
  expect(ciOf([{ __typename: 'StatusContext', state: 'ERROR' }])).toBe('failure')
})

test('gh JSON becomes PR rows and an issue count', () => {
  const prs = parsePrList(
    JSON.stringify([
      { number: 670, title: 'deps: bump multidict', isDraft: false, updatedAt: '2026-10-07T18:26:33Z', url: 'u', statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }] },
      { number: 651, title: 'deps: bump pyjwt', isDraft: false, updatedAt: '2026-10-01T17:07:16Z', url: 'v', statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
    ]),
  )
  expect(prs.map((p) => `${p.number}:${p.ci}`)).toEqual(['670:failure', '651:success'])
  expect(parsePrList('not json')).toEqual([])
  expect(parseIssueCount('[{"number":1},{"number":2}]')).toBe(2)
  expect(parseIssueCount('x')).toBe(null)
})

test('the review prompt names the repo, the PR and the standing rules', () => {
  const text = reviewPrompt('cdeust/Cortex', { number: 670, title: 'deps: bump multidict', isDraft: false, updatedAt: '', url: '', ci: 'failure' })
  expect(text).toContain('PR #670 of cdeust/Cortex')
  expect(text).toContain('head sha')
  expect(text).toContain('merge-gate.py with --repo')
  expect(text).toContain('Never merge, close or push from a mod')
})
