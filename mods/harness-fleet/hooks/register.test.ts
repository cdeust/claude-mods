import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

type Engine = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

import { FleetView } from './fleetview'

const INSTALLED = JSON.stringify({ plugins: { 'hypermnesia-mcp@cortex-plugins': [{ version: '4.23.4' }] } })
const MARKETPLACES = JSON.stringify({
  'cortex-plugins': { source: { source: 'github', repo: 'cdeust/cortex' }, installLocation: '/m/cortex', lastUpdated: '2026-09-22T22:53:29Z' },
})
const MANIFEST = JSON.stringify({ plugins: [{ name: 'hypermnesia-mcp', version: '4.24.0' }] })
const PRS = JSON.stringify([
  { number: 670, title: 'deps: bump multidict', isDraft: false, updatedAt: '2026-10-07T18:26:33Z', url: 'u', statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }] },
])

// The remote reading is background work the test cannot await (it would outlive the test's last
// await); it is off here and proven live through the pane. The inventory and the command are the
// hook's own work.
test(
  'session.start builds the inventory from the engine records and registers /fleet, running nothing',
  { options: { refresh_on_start: false } },
  async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const argvs: string[][] = []
  let registered = ''
  on('command.register', ($$, e) => {
    registered = String((e as { name?: string }).name ?? '')
    return { value: undefined } as never
  })
  on('session.start', () => ({ cwd: '/r' }))
  on('env.get', ($$, e) => ({ value: ({ HOME: '/home/t' } as Record<string, string>)[String((e as { name?: string }).name ?? '')] as never }))
  on('fs.read', ($$, e) => {
    const path = String((e as { path?: string }).path ?? '')
    if (path.endsWith('installed_plugins.json')) return { value: INSTALLED }
    if (path.endsWith('known_marketplaces.json')) return { value: MARKETPLACES }
    if (path.endsWith('marketplace.json')) return { value: MANIFEST }
    return { deny: `no such file in the test: ${path}` }
  })
  on('process.run', ($$, e) => {
    const argv = (e as { argv: string[] }).argv
    argvs.push(argv)
    const out = argv[1] === 'pr' ? PRS : argv[1] === 'issue' ? '[{"number":1,"title":"t","labels":[],"createdAt":"2026-10-01T00:00:00Z","url":"u","comments":[]}]' : ''
    return { value: { exitCode: 0, stdout: out, stderr: '' } as never }
  })
  on('state.get', ($$, e, next) =>
    (e as { plugin?: string }).plugin === 'harness-fleet' ? next(e) : { value: { value: undefined, version: 0 } as never },
  )
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' })
  expect(registered).toBe('fleet')
  expect(argvs).toEqual([])
  },
)

// After a /clear the session state starts empty and no session.start fires (engine doc), so the
// inventory must come back from a refresh alone. No session.start here: the pane starts empty,
// Refresh rebuilds the inventory from the engine records and reads the repository.
test('Refresh rebuilds the inventory without a session.start, as after a /clear', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-08T00:00:00Z') })
  on('env.get', ($$, e) => ({ value: ({ HOME: '/home/t' } as Record<string, string>)[String((e as { name?: string }).name ?? '')] as never }))
  on('fs.read', ($$, e) => {
    const path = String((e as { path?: string }).path ?? '')
    if (path.endsWith('installed_plugins.json')) return { value: INSTALLED }
    if (path.endsWith('known_marketplaces.json')) return { value: MARKETPLACES }
    if (path.endsWith('marketplace.json')) return { value: MANIFEST }
    return { deny: `no such file in the test: ${path}` }
  })
  on('process.run', ($$, e) => {
    const argv = (e as { argv: string[] }).argv
    const out = argv[1] === 'pr' ? PRS : argv[1] === 'issue' ? '[{"number":1,"title":"t","labels":[],"createdAt":"2026-10-01T00:00:00Z","url":"u","comments":[]}]' : ''
    return { value: { exitCode: 0, stdout: out, stderr: '' } as never }
  })
  on('state.get', ($$, e, next) =>
    (e as { plugin?: string }).plugin === 'harness-fleet' ? next(e) : { value: { value: undefined, version: 0 } as never },
  )
  const ui = await $.ui.mount({
    plugin: 'harness-fleet',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'harness-fleet',
    props: { title: 'Fleet', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  expect(await ui.find({ type: 'Text', text: /no owned plugin found/ })).toBeDefined()
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /hypermnesia-mcp 4\.23\.4 → 4\.24\.0 offered/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /#670 deps: bump multidict · CI failure/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 open PR · 1 open issues/ })).toBeDefined()
  await ui.unmount()
})

// The row the owner pasted on 2026-10-08: gh's GraphQL call ended in EOF, the PR list stayed empty
// and the pane said "0 open PRs" beside the error. A failed read must say "no reading".
test('a failed PR read says "PRs: no reading", never "0 open PRs"', async ($, on) => {
  on('ui.render', { component: 'Pane', requestId: 'failed-read' }, ($$, e) =>
    FleetView($$.ui.resolve(e) as never, {
      now: Date.parse('2026-10-08T00:00:00Z'),
      lessons: { refusals: 0, classifierErrors: 0, stuckEscalations: 0, leanCuts: 0 },
      fleet: {
        inventoryError: null,
        isRefreshing: false,
        readAt: Date.parse('2026-10-07T23:59:00Z'),
        repos: [
          {
            repo: 'cdeust/ai-architect-mcp-spec',
            local: null,
            marketplace: 'ai-architect-mcp-spec-marketplace',
            marketplaceUpdatedAt: '2026-09-09T20:59:09Z',
            plugins: [{ name: 'ai-architect-mcp-spec', installed: '0.8.0', offered: '0.8.0', isBehind: false }],
            manifestError: null,
            prTotal: null,
            prTotalError: null,
            issuesError: null,
            prs: [],
            issues: null,
            error: 'Post "https://api.github.com/graphql": EOF',
            readAt: Date.parse('2026-10-07T23:59:00Z'),
          },
        ],
      },
      onRefresh: () => {},
      onReview: () => {},
      onTake: () => {},
      onDraftIssue: () => {},
    }),
  )
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'harness-fleet',
      surface,
      component: 'Pane',
      requestId: 'failed-read',
      props: { title: 'Fleet', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: /gh: Post .*graphql.*: EOF/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /PRs: no reading · issues: no reading/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /0 open PRs/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the fleet pane validates and shows versions, CI and the lessons on terminal and desktop', async ($, on) => {
  on('ui.render', { component: 'Pane', requestId: 'populated' }, ($$, e) =>
    FleetView($$.ui.resolve(e) as never, {
      now: Date.parse('2026-10-08T00:00:00Z'),
      lessons: { refusals: 2, classifierErrors: 0, stuckEscalations: 1, leanCuts: 3 },
      fleet: {
        inventoryError: null,
        isRefreshing: false,
        readAt: Date.parse('2026-10-07T23:59:00Z'),
        repos: [
          {
            repo: 'cdeust/cortex',
            local: null,
            marketplace: 'cortex-plugins',
            marketplaceUpdatedAt: '2026-09-22T22:53:29Z',
            plugins: [{ name: 'hypermnesia-mcp', installed: '4.23.4', offered: '4.24.0', isBehind: true }],
            prs: [{ number: 670, title: 'deps: bump multidict', isDraft: false, updatedAt: '2026-10-07T18:26:33Z', url: 'u', ci: 'failure' }],
            manifestError: null,
            prTotal: 1,
            prTotalError: null,
            issuesError: null,
            issues: [
              { number: 667, title: 'SessionEnd dream cycle bypasses the launcher', labels: [], createdAt: '2026-10-06T10:00:00Z', comments: 0, url: 'u1' },
              { number: 359, title: 'feat(wiki): incremental regeneration', labels: ['enhancement'], createdAt: '2026-08-06T10:00:00Z', comments: 1, url: 'u2' },
            ],
            error: null,
            readAt: Date.parse('2026-10-07T23:59:00Z'),
          },
        ],
      },
      onRefresh: () => {},
      onReview: () => {},
      onTake: () => {},
      onDraftIssue: () => {},
    }),
  )
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'harness-fleet',
      surface,
      component: 'Pane',
      requestId: 'populated',
      props: { title: 'Fleet', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: /hypermnesia-mcp 4\.23\.4 → 4\.24\.0 offered/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /#670 deps: bump multidict · CI failure/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 open PR · 2 open issues/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 guard refusals · 0 classifier errors · 1 stuck escalations/ })).toBeDefined()
    expect(await ui.find({ key: 'review-cdeust/cortex-670' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /#667 \[defect\] SessionEnd dream cycle bypasses the launcher/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /#359 \[feature\] feat\(wiki\): incremental regeneration/ })).toBeDefined()
    expect(await ui.find({ key: 'take-cdeust/cortex-667' })).toBeDefined()
    expect(await ui.find({ key: 'take-cdeust/cortex-359' })).toBeDefined()
    expect(await ui.find({ key: 'draft-issue' })).toBeDefined()
    await ui.unmount()
  }
})

// ---- the failure paths the audit (3.3) read from code and no test ran ----

type Ran = { exitCode: number; stdout: string; stderr: string } | { deny: string }
type World = {
  env?: Record<string, string>
  files?: Record<string, string | { deny: string }>
  run?: (argv: string[]) => Ran
  // Every path fs.read was asked for.
  reads?: string[]
  // env.get rejects with this instead of answering.
  envDeny?: string
  // clock.now rejects once, on the first call after the three inventory files were read: the call
  // readRepo makes first, so the rejection reaches the refresh itself.
  clockDenyOnce?: string
}

const ISSUES_OK = '[{"number":1,"title":"t","labels":[],"createdAt":"2026-10-01T00:00:00Z","url":"u","comments":[]}]'
const okRun = (stdout: string): Ran => ({ exitCode: 0, stdout, stderr: '' })
// What gh answers when nothing is wrong: the PR list, the issue list, the PR count.
const healthy = (argv: string[]): Ran =>
  argv[1] === 'pr' ? okRun(PRS) : argv[1] === 'issue' ? okRun(ISSUES_OK) : okRun('')

const PANE_PROPS = { title: 'Fleet', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

// Mounts the pane over a fake machine and presses Refresh. Every engine call the mod makes lands
// on this world: env by name, files by path suffix, processes by argv.
async function refreshed($: Engine, on: On, w: World) {
  let files = 0
  let hasDenied = false
  if (w.clockDenyOnce === undefined) mock.clock(on, { now: Date.parse('2026-10-08T00:00:00Z') })
  else {
    on('clock.now', () => {
      if (files >= 3 && !hasDenied) {
        hasDenied = true
        return { deny: w.clockDenyOnce ?? '' }
      }
      return { value: Date.parse('2026-10-08T00:00:00Z') }
    })
  }
  const env = w.env ?? { HOME: '/home/t' }
  on('env.get', ($$, e) =>
    w.envDeny === undefined ? { value: env[String((e as { name?: string }).name ?? '')] as never } : { deny: w.envDeny },
  )
  on('fs.read', ($$, e) => {
    const path = String((e as { path?: string }).path ?? '')
    w.reads?.push(path)
    files += 1
    const hit = Object.entries({ 'installed_plugins.json': INSTALLED, 'known_marketplaces.json': MARKETPLACES, 'marketplace.json': MANIFEST, ...w.files }).find(([suffix]) => path.endsWith(suffix))
    if (hit === undefined) return { deny: `no such file in the test: ${path}` }
    return typeof hit[1] === 'string' ? { value: hit[1] } : hit[1]
  })
  on('process.run', ($$, e) => {
    const out = (w.run ?? healthy)((e as { argv: string[] }).argv)
    return 'deny' in out ? out : { value: out as never }
  })
  on('state.get', ($$, e, next) =>
    (e as { plugin?: string }).plugin === 'harness-fleet' ? next(e) : { value: { value: undefined, version: 0 } as never },
  )
  const ui = await $.ui.mount({ plugin: 'harness-fleet', surface: 'terminal', component: 'Pane', requestId: 'harness-fleet', props: PANE_PROPS })
  await ui.press({ key: 'refresh' })
  return ui
}

test('gh refused by the machine: the row carries the refusal, the refresh still ends', async ($, on) => {
  const ui = await refreshed($, on, { run: () => ({ deny: 'spawn gh EPERM: refused by the sandbox' }) })
  expect(await ui.find({ type: 'Text', text: /gh: could not run gh pr list.*EPERM: refused by the sandbox/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /PRs: no reading · issues: no reading/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /hypermnesia-mcp 4\.23\.4 → 4\.24\.0 offered/ })).toBeDefined()
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /remote: not read yet/ })).toBeUndefined()
  await ui.unmount()
})

test('a gh call that outlasts its timeout rejects: the row says so, and the reason is cut', async ($, on) => {
  const long = `timed out after 20000 ms ${'x'.repeat(300)}`
  const ui = await refreshed($, on, { run: (argv) => (argv[1] === 'issue' ? okRun(ISSUES_OK) : { deny: long }) })
  expect(await ui.find({ type: 'Text', text: /gh: could not run gh pr list --repo cdeust\/cortex: .*timed out after 20000 ms/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: new RegExp(`x{121}`) })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /PRs: no reading · 1 open issues/ })).toBeDefined()
  await ui.unmount()
})

test('a refusal on the issue list alone keeps the PRs and says why the issues are missing', async ($, on) => {
  const ui = await refreshed($, on, {
    run: (argv) => (argv[1] === 'issue' ? { exitCode: 1, stdout: '', stderr: 'HTTP 403: API rate limit exceeded' } : healthy(argv)),
  })
  expect(await ui.find({ type: 'Text', text: /#670 deps: bump multidict · CI failure/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /gh issues: HTTP 403: API rate limit exceeded/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 open PR · issues: no reading/ })).toBeDefined()
  await ui.unmount()
})

test('gh answering something that is not a PR list is an error on the row, not 0 open PRs', async ($, on) => {
  const ui = await refreshed($, on, { run: (argv) => (argv[1] === 'pr' ? okRun('<html>Unicorn!</html>') : healthy(argv)) })
  expect(await ui.find({ type: 'Text', text: /gh: gh pr list output is not valid JSON/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /PRs: no reading/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0 open PRs/ })).toBeUndefined()
  await ui.unmount()
})

const prRows = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ number: 100 - i, title: `pr ${100 - i}`, isDraft: false, updatedAt: '2026-10-07T18:26:33Z', url: 'u', statusCheckRollup: [] })))

test('40 open PRs: the pane reads "10 of 40", lists ten, and the count call is a read', async ($, on) => {
  const argvs: string[][] = []
  const ui = await refreshed($, on, {
    run: (argv) => {
      argvs.push(argv)
      if (argv[1] === 'pr') return okRun(prRows(11)) // gh returns what --limit asks: the cap plus one
      if (argv[1] === 'api') return okRun('{"data":{"repository":{"pullRequests":{"totalCount":40}}}}')
      return healthy(argv)
    },
  })
  expect(await ui.find({ type: 'Text', text: /10 of 40 open PRs · 1 open issues/ })).toBeDefined()
  expect(await ui.find({ key: 'review-cdeust/cortex-91' })).toBeDefined()
  expect(await ui.find({ key: 'review-cdeust/cortex-90' })).toBeUndefined()
  expect(argvs.find((a) => a[1] === 'pr')).toContain('11')
  expect(argvs.find((a) => a[1] === 'api')?.slice(0, 3)).toEqual(['gh', 'api', 'graphql'])
  expect(argvs.every((a) => a[0] === 'gh' || a[0] === 'git')).toBe(true)
  expect(argvs.flat().some((t) => /mutation|--method|-X|POST/.test(t))).toBe(false)
  await ui.unmount()
})

test('10 or fewer open PRs cost no count call', async ($, on) => {
  const argvs: string[][] = []
  const ui = await refreshed($, on, { run: (argv) => (argvs.push(argv), healthy(argv)) })
  expect(await ui.find({ type: 'Text', text: /1 open PR · 1 open issues/ })).toBeDefined()
  expect(argvs.some((a) => a[1] === 'api')).toBe(false)
  await ui.unmount()
})

test('a PR count that fails is named, never a bare "10 open PRs"', async ($, on) => {
  const ui = await refreshed($, on, {
    run: (argv) => (argv[1] === 'pr' ? okRun(prRows(11)) : argv[1] === 'api' ? { exitCode: 1, stdout: '', stderr: 'graphql: bad gateway' } : healthy(argv)),
  })
  expect(await ui.find({ type: 'Text', text: /10 open PRs shown, total not read \(graphql: bad gateway\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^10 open PRs ·/ })).toBeUndefined()
  await ui.unmount()
})

const TWO = {
  installed: JSON.stringify({ plugins: { 'a@mp-a': [{ version: '1.0.0' }], 'b@mp-b': [{ version: '2.0.0' }] } }),
  marketplaces: JSON.stringify({
    'mp-a': { source: { source: 'github', repo: 'cdeust/repo-a' }, installLocation: '/m/a' },
    'mp-b': { source: { source: 'github', repo: 'cdeust/repo-b' }, installLocation: '/m/b' },
  }),
}

test('one repository failing does not take the others with it', async ($, on) => {
  const ui = await refreshed($, on, {
    files: { 'installed_plugins.json': TWO.installed, 'known_marketplaces.json': TWO.marketplaces, 'marketplace.json': '{"plugins":[]}' },
    run: (argv) => (argv.includes('cdeust/repo-b') ? { deny: 'connection reset' } : healthy(argv)),
  })
  expect(await ui.find({ type: 'Text', text: /gh: could not run gh pr list --repo cdeust\/repo-b: .*connection reset/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 open PR · 1 open issues/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /#670 deps: bump multidict/ })).toBeDefined()
  await ui.unmount()
})

const CORRUPT_RECORDS = [
  ['installed_plugins.json', '{truncated', /inventory: .*installed_plugins\.json is not valid JSON/],
  ['known_marketplaces.json', '', /inventory: .*known_marketplaces\.json is not valid JSON/],
  ['installed_plugins.json', '{"plugins":[1]}', /inventory: .*installed_plugins\.json has no "plugins" object/],
] as const
for (const [file, text, shown] of CORRUPT_RECORDS) {
  test(`a corrupt ${file} (${text === '' ? 'empty' : text}) shows as an inventory error, not as "no owned plugin found"`, async ($, on) => {
    const ui = await refreshed($, on, { files: { [file]: text } })
    expect(await ui.find({ type: 'Text', text: shown })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /no owned plugin found/ })).toBeUndefined()
    await ui.unmount()
  })
}

test('an unreadable installed_plugins.json names the refusal', async ($, on) => {
  const ui = await refreshed($, on, { files: { 'installed_plugins.json': { deny: 'EACCES: permission denied' } } })
  expect(await ui.find({ type: 'Text', text: /inventory: .*EACCES: permission denied/ })).toBeDefined()
  await ui.unmount()
})

const BAD_MANIFESTS = [
  ['corrupt', '<<<'],
  ['unreadable', { deny: 'EACCES: permission denied' }],
] as const
for (const [kind, manifest] of BAD_MANIFESTS) {
  test(`a ${kind} marketplace manifest shows the offered version as unknown, with the reason`, async ($, on) => {
    const ui = await refreshed($, on, { files: { 'marketplace.json': manifest } })
    expect(await ui.find({ type: 'Text', text: /hypermnesia-mcp 4\.23\.4 · offered unknown/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /manifest: .*(marketplace\.json is not valid JSON|EACCES: permission denied)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /offered$|· current/ })).toBeUndefined()
    await ui.unmount()
  })
}

// The home and the config directory (paths.ts): HOME, else USERPROFILE, CLAUDE_CONFIG_DIR for what
// the engine keeps under ~/.claude.
test('CLAUDE_CONFIG_DIR relocates the engine records, whatever HOME says', async ($, on) => {
  const reads: string[] = []
  const ui = await refreshed($, on, { env: { HOME: '/home/t', CLAUDE_CONFIG_DIR: '/work/cfg' }, reads })
  expect(await ui.find({ type: 'Text', text: /hypermnesia-mcp 4\.23\.4 → 4\.24\.0 offered/ })).toBeDefined()
  expect(reads).toContain('/work/cfg/plugins/installed_plugins.json')
  expect(reads).toContain('/work/cfg/plugins/known_marketplaces.json')
  expect(reads.some((r) => r.startsWith('/home/t'))).toBe(false)
  await ui.unmount()
})

test('without HOME the home is USERPROFILE (a Windows machine)', async ($, on) => {
  const reads: string[] = []
  const ui = await refreshed($, on, { env: { USERPROFILE: 'C:\\Users\\t' }, reads })
  expect(await ui.find({ type: 'Text', text: /hypermnesia-mcp 4\.23\.4 → 4\.24\.0 offered/ })).toBeDefined()
  // This engine is POSIX and resolves the Windows spelling against the working directory; the tail is the mod's.
  expect(reads.some((r) => r.endsWith('C:\\Users\\t/.claude/plugins/installed_plugins.json'))).toBe(true)
  await ui.unmount()
})

test('with no HOME, USERPROFILE or CLAUDE_CONFIG_DIR the inventory error says so, and reads nothing at /', async ($, on) => {
  const reads: string[] = []
  const ui = await refreshed($, on, { env: {}, reads })
  expect(await ui.find({ type: 'Text', text: /inventory: ~\/\.claude\/plugins\/installed_plugins\.json has no place: neither HOME nor USERPROFILE is set/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /no owned plugin found/ })).toBeUndefined()
  expect(reads).toEqual([])
  await ui.unmount()
})

test('an environment the sandbox refuses to read is an inventory error with the refusal', async ($, on) => {
  const ui = await refreshed($, on, { envDeny: 'env.get is not allowed here' })
  expect(await ui.find({ type: 'Text', text: /inventory: .*env\.get is not allowed here/ })).toBeDefined()
  await ui.unmount()
})

test('a refresh that fails outside any one repository says so on the pane and ends', async ($, on) => {
  const ui = await refreshed($, on, { clockDenyOnce: 'clock refused' })
  expect(await ui.find({ type: 'Text', text: /inventory: refresh failed: .*clock refused/ })).toBeDefined()
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
  await ui.unmount()
})

const DIRECTORY = {
  installed: JSON.stringify({ plugins: { 'a@mp-dir': [{ version: '1.0.0' }] } }),
  marketplaces: JSON.stringify({ 'mp-dir': { source: { source: 'directory', path: '/dev/x' }, installLocation: '/dev/x' } }),
}
const directoryFiles = { 'installed_plugins.json': DIRECTORY.installed, 'known_marketplaces.json': DIRECTORY.marketplaces, 'marketplace.json': '{"plugins":[]}' }

test('a directory marketplace whose git remote cannot be read shows git\'s reason, not "no GitHub remote"', async ($, on) => {
  const ui = await refreshed($, on, {
    files: directoryFiles,
    run: (argv) => (argv[0] === 'git' ? { exitCode: 128, stdout: '', stderr: 'fatal: detected dubious ownership in repository at /dev/x' } : healthy(argv)),
  })
  expect(await ui.find({ type: 'Text', text: /gh: fatal: detected dubious ownership in repository/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /no GitHub remote/ })).toBeUndefined()
  await ui.unmount()
})

test('a git the machine will not start is the reason on the directory marketplace row', async ($, on) => {
  const ui = await refreshed($, on, {
    files: directoryFiles,
    run: (argv) => (argv[0] === 'git' ? { deny: 'spawn git EPERM' } : healthy(argv)),
  })
  expect(await ui.find({ type: 'Text', text: /gh: could not run git -C \/dev\/x remote get-url: .*EPERM/ })).toBeDefined()
  await ui.unmount()
})

test('a directory marketplace whose remote is not on GitHub says that', async ($, on) => {
  const ui = await refreshed($, on, {
    files: directoryFiles,
    run: (argv) => (argv[0] === 'git' ? okRun('https://gitlab.com/x/y.git\n') : healthy(argv)),
  })
  expect(await ui.find({ type: 'Text', text: /gh: no GitHub remote/ })).toBeDefined()
  await ui.unmount()
})

test('a directory marketplace on GitHub is read through its remote', async ($, on) => {
  const argvs: string[][] = []
  const ui = await refreshed($, on, {
    files: directoryFiles,
    run: (argv) => (argvs.push(argv), argv[0] === 'git' ? okRun('git@github.com:cdeust/x.git\n') : healthy(argv)),
  })
  expect(await ui.find({ type: 'Text', text: /#670 deps: bump multidict/ })).toBeDefined()
  expect(argvs.some((a) => a.includes('cdeust/x'))).toBe(true)
  await ui.unmount()
})
