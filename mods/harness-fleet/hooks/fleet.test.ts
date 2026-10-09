import { expect, test } from 'claude-code/testing'

import {
  ciOf,
  fleetRows,
  isBehind,
  parseInstalled,
  issueKind,
  parseIssues,
  parseMarketplaces,
  parseOffered,
  parsePrCount,
  parsePrList,
  PR_LIMIT,
  prCountArgv,
  prListArgv,
  prsLabel,
  repoOfRemote,
  reviewPrompt,
  takeIssuePrompt,
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
  const rows = fleetRows(parseInstalled(INSTALLED), parseMarketplaces(MARKETPLACES), { 'cortex-plugins': { offered: parseOffered(CORTEX_MANIFEST) } }, 'cdeust')
  expect(rows.map((r) => r.marketplace)).toEqual(['cortex-plugins', 'spec-marketplace'])
  const cortex = rows[0]
  expect(cortex?.repo).toBe('cdeust/cortex')
  expect(cortex?.plugins.map((p) => `${p.name}:${p.isBehind}`)).toEqual(['hypermnesia-mcp:true', 'hypermnesia-mcp-viz:false'])
  expect(rows[1]?.local).toBe('/dev/spec')
  expect(rows[1]?.plugins[0]?.offered).toBe(null)
  expect(rows[1]?.manifestError).toBe(null)
})

test('a marketplace whose manifest could not be read carries the reason on its row, never an empty offer', () => {
  const rows = fleetRows(parseInstalled(INSTALLED), parseMarketplaces(MARKETPLACES), { 'cortex-plugins': { error: 'ENOENT: no such file' } }, 'cdeust')
  expect(rows[0]?.manifestError).toBe('ENOENT: no such file')
  expect(rows[0]?.plugins.map((p) => p.offered)).toEqual([null, null])
})

// The audit (3.3) read these from code: parseJson returned undefined on bad JSON and every parser
// then returned an empty list, the wording of a clean empty machine.
test('a record that is not the JSON the engine writes is an error that names it, never an empty list', () => {
  expect(() => parseInstalled('{not json')).toThrow(/installed_plugins\.json is not valid JSON/)
  expect(() => parseInstalled('[]')).toThrow(/installed_plugins\.json has no "plugins" object/)
  expect(() => parseInstalled(JSON.stringify({ plugins: { 'a@b': 'x' } }))).toThrow(/installed_plugins\.json: "a@b" is not a list/)
  expect(parseInstalled(JSON.stringify({ plugins: {} }))).toEqual([])
  expect(() => parseMarketplaces('')).toThrow(/known_marketplaces\.json is not valid JSON/)
  expect(() => parseMarketplaces('[]')).toThrow(/known_marketplaces\.json is not an object/)
  expect(parseMarketplaces('{}')).toEqual([])
  expect(() => parseOffered('<html>')).toThrow(/marketplace\.json is not valid JSON/)
  expect(() => parseOffered('{}')).toThrow(/marketplace\.json has no "plugins" list/)
  expect(parseOffered('{"plugins":[]}')).toEqual({})
})

test('PRs: the list reads one past the cap so truncation is known, and the pane says what it shows', () => {
  expect(prListArgv('a/b')).toContain(String(PR_LIMIT + 1))
  const row = { prs: Array.from({ length: PR_LIMIT }, (_, i) => ({ number: i })) as never[], error: null, prTotal: 40, prTotalError: null }
  expect(prsLabel(row)).toBe('10 of 40 open PRs')
  expect(prsLabel({ ...row, prs: row.prs.slice(0, 1), prTotal: 1 })).toBe('1 open PR')
  expect(prsLabel({ ...row, prs: [], prTotal: 0 })).toBe('0 open PRs')
  expect(prsLabel({ ...row, prTotal: null, prTotalError: 'graphql: 502' })).toBe('10 open PRs shown, total not read (graphql: 502)')
  expect(prsLabel({ ...row, error: 'boom', prTotal: null })).toBe('PRs: no reading')
  expect(parsePrCount('{"data":{"repository":{"pullRequests":{"totalCount":40}}}}')).toBe(40)
  expect(() => parsePrCount('{"data":null}')).toThrow(/totalCount/)
  expect(() => parsePrCount('x')).toThrow(/not valid JSON/)
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

test('gh JSON becomes PR rows and issue rows', () => {
  const prs = parsePrList(
    JSON.stringify([
      { number: 670, title: 'deps: bump multidict', isDraft: false, updatedAt: '2026-10-07T18:26:33Z', url: 'u', statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }] },
      { number: 651, title: 'deps: bump pyjwt', isDraft: false, updatedAt: '2026-10-01T17:07:16Z', url: 'v', statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
    ]),
  )
  expect(prs.map((p) => `${p.number}:${p.ci}`)).toEqual(['670:failure', '651:success'])
  expect(() => parsePrList('not json')).toThrow(/gh pr list output is not valid JSON/)
  expect(() => parsePrList('{}')).toThrow(/gh pr list output is not a list/)
  const issues = parseIssues(
    JSON.stringify([
      { number: 667, title: 'SessionEnd dream cycle bypasses the launcher', labels: [], createdAt: '2026-10-06T10:00:00Z', url: 'u1', comments: [] },
      { number: 359, title: 'feat(wiki): incremental regeneration', labels: [{ name: 'enhancement' }], createdAt: '2026-08-06T10:00:00Z', url: 'u2', comments: [{ body: 'x' }] },
      { title: 'no number: dropped' },
    ]),
  )
  expect(issues?.map((i) => `${i.number}:${i.labels.join('+')}:${i.comments}`)).toEqual(['667::0', '359:enhancement:1'])
  expect(() => parseIssues('x')).toThrow(/gh issue list output is not valid JSON/)
  expect(() => parseIssues('{}')).toThrow(/gh issue list output is not a list/)
  expect(parseIssues('[]')).toEqual([])
})

test('a label that names a request routes an issue to an assessment, anything else to a fix', () => {
  expect(issueKind([])).toBe('defect')
  expect(issueKind(['bug'])).toBe('defect')
  expect(issueKind(['Enhancement'])).toBe('feature')
  expect(issueKind(['bug', 'question'])).toBe('feature')
})

test('the take-issue prompt asks for a fix under the standing rules, or for the owner\'s decision on a feature', () => {
  const defect = takeIssuePrompt('cdeust/Cortex', { number: 667, title: 'SessionEnd dream cycle bypasses the launcher', labels: ['bug'], createdAt: '', comments: 2, url: '' })
  expect(defect).toContain('Take issue #667 of cdeust/Cortex')
  expect(defect).toContain('fails before the fix')
  expect(defect).toContain('registered with disk-hygiene')
  expect(defect).toContain('merge-gate.py with --repo')
  expect(defect).toContain('Never close an issue without evidence')
  const feature = takeIssuePrompt('cdeust/Cortex', { number: 359, title: 'feat(wiki): incremental regeneration', labels: ['enhancement'], createdAt: '', comments: 0, url: '' })
  expect(feature).toContain('is a feature request')
  expect(feature).toContain("owner's decision")
  expect(feature).toContain('before writing any code')
  expect(feature).not.toContain('registered with disk-hygiene')
})

test('the review prompt names the repo, the PR and the standing rules', () => {
  const text = reviewPrompt('cdeust/Cortex', { number: 670, title: 'deps: bump multidict', isDraft: false, updatedAt: '', url: '', ci: 'failure' })
  expect(text).toContain('PR #670 of cdeust/Cortex')
  expect(text).toContain('head sha')
  expect(text).toContain('merge-gate.py with --repo')
  expect(text).toContain('Never merge, close or push from a mod')
})

test('the PR count query is OPEN pull requests, and owner and name travel as raw strings (-f, never -F)', () => {
  const argv = prCountArgv('cdeust/2024')
  expect(argv.slice(0, 3)).toEqual(['gh', 'api', 'graphql'])
  expect(argv.join(' ')).toContain('pullRequests(states:OPEN)')
  expect(argv).toContain('owner=cdeust')
  expect(argv).toContain('name=2024')
  expect(argv).not.toContain('-F')
  expect(argv[argv.indexOf('owner=cdeust') - 1]).toBe('-f')
  expect(argv[argv.indexOf('name=2024') - 1]).toBe('-f')
})
