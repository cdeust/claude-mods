import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FleetState, PrRow, RepoRow } from '../types'
import {
  INSTALLED_PLUGINS_PATH,
  KNOWN_MARKETPLACES_PATH,
  MARKETPLACE_MANIFEST,
  type Lessons,
  draftIssuePrompt,
  fleetRows,
  issueListArgv,
  parseInstalled,
  parseIssueCount,
  parseMarketplaces,
  parseOffered,
  parsePrList,
  prListArgv,
  remoteArgv,
  repoOfRemote,
  reviewPrompt,
} from './fleet'
import { FleetView } from './fleetview'

const PANE = 'harness-fleet'
const GH_TIMEOUT_MS = 20_000 // source: own choice, gh answers in 1–3 s; a stalled call must not hold the pane

const fleet = atom({ plugin: 'harness-fleet', key: 'fleet' } as const, {
  repos: [],
  inventoryError: null,
  isRefreshing: false,
  readAt: null,
} as FleetState)

// The signals the LESSONS section counts come from the other mods' state (dependencies); read only.
const GUARD_REFUSALS = { plugin: 'cortex-guard', key: 'refusals' } as const
const GENIUS_STATE = { plugin: 'zetetic-genius', key: 'state' } as const
const AUTOPILOT_POLICY = { plugin: 'zetetic-autopilot', key: 'policy' } as const

const expandHome = async ($: EngineInterface, path: string): Promise<string> =>
  path.startsWith('~/') ? `${(await $.env.get('HOME')) ?? ''}/${path.slice(2)}` : path

async function lessonsOf($: EngineInterface): Promise<Lessons> {
  const l: Lessons = { refusals: 0, classifierErrors: 0, stuckEscalations: 0, leanCuts: 0 }
  try {
    l.refusals = ((await $.state.get(GUARD_REFUSALS)).value ?? []).length
  } catch {
    // the guard is not loaded: zero refusals seen
  }
  try {
    const g = (await $.state.get(GENIUS_STATE)).value
    l.classifierErrors = g?.classifierError === null || g?.classifierError === undefined ? 0 : 1
  } catch {
    // the genius router is not loaded
  }
  try {
    const p = (await $.state.get(AUTOPILOT_POLICY)).value
    l.stuckEscalations = p?.decisions.filter((d) => d.kind === 'stuck').length ?? 0
    l.leanCuts = p?.decisions.filter((d) => d.kind === 'lean').length ?? 0
  } catch {
    // the autopilot is not loaded
  }
  return l
}

// The inventory is local: the engine's records and each owned marketplace's manifest.
async function loadInventory($: EngineInterface, owner: string): Promise<void> {
  try {
    const installed = parseInstalled(await $.fs.read(await expandHome($, INSTALLED_PLUGINS_PATH)))
    const marketplaces = parseMarketplaces(await $.fs.read(await expandHome($, KNOWN_MARKETPLACES_PATH)))
    const offered: Record<string, Record<string, string>> = {}
    for (const m of marketplaces) {
      try {
        offered[m.name] = parseOffered(await $.fs.read(`${m.installLocation}/${MARKETPLACE_MANIFEST}`))
      } catch {
        offered[m.name] = {}
      }
    }
    const repos = fleetRows(installed, marketplaces, offered, owner)
    await update($, fleet, (f) => ({ ...f, repos, inventoryError: null }))
  } catch (error) {
    await update($, fleet, (f) => ({ ...f, inventoryError: String(error).slice(0, 140) }))
  }
}

// One repository's remote reading: open PRs with their CI, the open issue count. Read-only gh.
async function readRepo($: EngineInterface, r: RepoRow): Promise<RepoRow> {
  const readAt = await $.clock.now()
  let repo = r.repo
  if (repo === null && r.local !== null) {
    const remote = await $.process.run(remoteArgv(r.local), { timeoutMs: GH_TIMEOUT_MS })
    repo = remote.exitCode === 0 ? repoOfRemote(remote.stdout) : null
  }
  if (repo === null) return { ...r, readAt, error: r.local === null ? 'no repository' : 'no GitHub remote' }
  const [prs, issues] = await Promise.all([
    $.process.run(prListArgv(repo), { timeoutMs: GH_TIMEOUT_MS }),
    $.process.run(issueListArgv(repo), { timeoutMs: GH_TIMEOUT_MS }),
  ])
  if (prs.exitCode !== 0) return { ...r, repo, readAt, error: prs.stderr.trim().slice(0, 120) || `gh exit ${prs.exitCode}` }
  return {
    ...r,
    repo,
    readAt,
    error: null,
    prs: parsePrList(prs.stdout),
    openIssues: issues.exitCode === 0 ? parseIssueCount(issues.stdout) : null,
  }
}

async function refreshRemote($: EngineInterface): Promise<void> {
  const before = await read($, fleet)
  if (before.isRefreshing) return
  await update($, fleet, (f) => ({ ...f, isRefreshing: true }))
  try {
    const repos = await Promise.all(before.repos.map((r) => readRepo($, r)))
    await update($, fleet, (f) => ({ ...f, repos, readAt: repos[0]?.readAt ?? f.readAt }))
  } finally {
    await update($, fleet, (f) => ({ ...f, isRefreshing: false }))
  }
}

export const register: Register = (on, options) => {
  const owner = String(options.github_owner ?? 'cdeust')
  const refreshOnStart = options.refresh_on_start !== false

  on('session.start', async ($, e, next) => {
    await loadInventory($, owner)
    try {
      await $.command.register({ name: 'fleet', description: 'Open the harness fleet pane: plugins, versions, PRs, CI', immediate: true })
    } catch (error) {
      $.ui.toast(`/fleet is taken by another plugin: ${String(error).slice(0, 80)}`)
    }
    // Not awaited: nine repositories of gh calls would outlast the hook's budget; the pane
    // says "remote: not read yet" until the reading lands.
    if (refreshOnStart) void refreshRemote($)

    return next(e)
  })

  on('command.run', { command: 'fleet' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'Fleet' })
    void refreshRemote($)

    return { text: 'Harness fleet opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    FleetView($.ui.resolve(e) as never, {
      fleet: await read($, fleet),
      lessons: await lessonsOf($),
      now: await $.clock.now(),
      onRefresh: () => void refreshRemote($),
      onReview: (repo: string, pr: PrRow) => void $.prompt.submit({ text: reviewPrompt(repo, pr) }),
      onDraftIssue: () =>
        void (async () => {
          const f = await read($, fleet)
          const repos = f.repos.map((r) => r.repo).filter((r): r is string => r !== null)
          await $.prompt.submit({ text: draftIssuePrompt(repos, await lessonsOf($)) })
        })(),
    }),
  )
}
