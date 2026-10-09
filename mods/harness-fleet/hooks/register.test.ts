import { expect, mock, test } from 'claude-code/testing'

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
  on('env.get', () => ({ value: '/home/t' }))
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
  on('env.get', () => ({ value: '/home/t' }))
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
