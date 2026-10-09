import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FleetState, IssueRow, PrRow, RepoRow } from '../types'
import { placePath } from './paths'
import {
  INSTALLED_PLUGINS_PATH,
  KNOWN_MARKETPLACES_PATH,
  MARKETPLACE_MANIFEST,
  type Lessons,
  draftIssuePrompt,
  fleetRows,
  type ManifestRead,
  PR_LIMIT,
  issueListArgv,
  parseInstalled,
  parseIssues,
  parseMarketplaces,
  parseOffered,
  parsePrCount,
  parsePrList,
  prCountArgv,
  prListArgv,
  remoteArgv,
  repoOfRemote,
  reviewPrompt,
  takeIssuePrompt,
} from './fleet'
import { FleetView } from './fleetview'

const PANE = 'harness-fleet'
const REASON_CAP = 120 // source: the cut the pane already applied to a gh error line
const why = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 140)
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

// Where a `~/` path lands on this machine: HOME, else USERPROFILE, and CLAUDE_CONFIG_DIR for what lives
// in the engine's config directory (paths.ts). No home to place it is an error with that reason.
async function expandHome($: EngineInterface, path: string): Promise<string> {
  if (!path.startsWith('~/')) return path
  const placed = placePath(
    { home: await $.env.get('HOME'), userProfile: await $.env.get('USERPROFILE'), configDir: await $.env.get('CLAUDE_CONFIG_DIR') },
    path,
  )
  if ('reason' in placed) throw new Error(placed.reason)

  return placed.path
}

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

// The inventory is local: the engine's records and each owned marketplace's manifest. Rejects
// when a record cannot be read or is not the JSON the engine writes; a manifest that cannot be
// read is carried on its marketplace's row, as the reason its offered versions are unknown.
async function buildInventory($: EngineInterface, owner: string): Promise<RepoRow[]> {
  const installed = parseInstalled(await $.fs.read(await expandHome($, INSTALLED_PLUGINS_PATH)))
  const marketplaces = parseMarketplaces(await $.fs.read(await expandHome($, KNOWN_MARKETPLACES_PATH)))
  const offered: Record<string, ManifestRead> = {}
  for (const m of marketplaces) {
    try {
      offered[m.name] = { offered: parseOffered(await $.fs.read(`${m.installLocation}/${MARKETPLACE_MANIFEST}`)) }
    } catch (error) {
      offered[m.name] = { error: why(error) }
    }
  }
  return fleetRows(installed, marketplaces, offered, owner)
}

async function loadInventory($: EngineInterface, owner: string): Promise<void> {
  try {
    const repos = await buildInventory($, owner)
    await update($, fleet, (f) => ({ ...f, repos, inventoryError: null }))
  } catch (error) {
    await update($, fleet, (f) => ({ ...f, inventoryError: why(error) }))
  }
}

type Ran = { exitCode: number; stdout: string; stderr: string }
// One read-only command: what it answered, or the reason it did not (a refusal, a timeout, a
// missing binary all reject the engine's call).
type Call = { ran: Ran } | { failed: string }

async function run($: EngineInterface, argv: string[]): Promise<Call> {
  try {
    return { ran: await $.process.run(argv, { timeoutMs: GH_TIMEOUT_MS }) }
  } catch (error) {
    return { failed: `could not run ${argv.slice(0, 5).join(' ')}: ${why(error)}` }
  }
}

// The reason a call gave no answer worth parsing: it did not run, or it exited non-zero.
const refusal = (c: Call): string | null =>
  'failed' in c ? c.failed : c.ran.exitCode === 0 ? null : c.ran.stderr.trim().slice(0, REASON_CAP) || `gh exit ${c.ran.exitCode}`

// The parser's own words when gh answered with something that is not the list it was asked for.
const parsed = <T,>(c: Call, parse: (stdout: string) => T): { value: T } | { failed: string } => {
  if ('failed' in c) return c
  const r = refusal(c)
  if (r !== null) return { failed: r }
  try {
    return { value: parse(c.ran.stdout) }
  } catch (error) {
    return { failed: why(error) }
  }
}

// The exact number of open PRs, asked only when the list came back truncated.
async function countPrs($: EngineInterface, repo: string): Promise<{ total: number } | { failed: string }> {
  const got = parsed(await run($, prCountArgv(repo)), parsePrCount)
  return 'value' in got ? { total: got.value } : got
}

// One repository's remote reading: open PRs with their CI, the open issue count. Read-only gh.
// Every failure lands on this repository's row (error for the PR list, issuesError for the issue
// list, prTotalError for the count), so one refused call never takes the other rows with it.
async function readRepo($: EngineInterface, r: RepoRow): Promise<RepoRow> {
  const readAt = await $.clock.now()
  let repo = r.repo
  if (repo === null && r.local !== null) {
    const remote = await run($, remoteArgv(r.local))
    const failed = refusal(remote)
    if (failed !== null) return { ...r, readAt, error: failed }
    repo = 'ran' in remote ? repoOfRemote(remote.ran.stdout) : null
  }
  if (repo === null) return { ...r, readAt, error: r.local === null ? 'no repository' : 'no GitHub remote' }
  const [prCall, issueCall] = await Promise.all([run($, prListArgv(repo)), run($, issueListArgv(repo))])
  const issues = parsed(issueCall, parseIssues)
  const issuesRead = { issues: 'value' in issues ? issues.value : null, issuesError: 'failed' in issues ? issues.failed : null }
  const list = parsed(prCall, parsePrList)
  if ('failed' in list) return { ...r, repo, readAt, error: list.failed, ...issuesRead }
  const prs = list.value.slice(0, PR_LIMIT)
  if (list.value.length <= PR_LIMIT) return { ...r, repo, readAt, error: null, prs, prTotal: prs.length, prTotalError: null, ...issuesRead }
  const count = await countPrs($, repo)
  return {
    ...r,
    repo,
    readAt,
    error: null,
    prs,
    prTotal: 'total' in count ? count.total : null,
    prTotalError: 'failed' in count ? count.failed : null,
    ...issuesRead,
  }
}

// source: the engine's session.start doc ("once per process for each loaded plugin ... never
// /clear") and SessionEndInput.reason ("the process goes on under a new session id, and no
// session.start fires for it"): after a /clear the session state starts empty and no event
// rebuilds the inventory. So every refresh rebuilds it first; the local reads also pick up a
// plugin installed or a marketplace updated since the session began. The rows already shown
// stay on screen until the remote reading lands: the state is written once, at the end.
async function refreshRemote($: EngineInterface, owner: string): Promise<void> {
  const before = await read($, fleet)
  if (before.isRefreshing) return
  await update($, fleet, (f) => ({ ...f, isRefreshing: true }))
  try {
    let inventory: RepoRow[]
    try {
      inventory = await buildInventory($, owner)
    } catch (error) {
      await update($, fleet, (f) => ({ ...f, inventoryError: why(error) }))
      return
    }
    const repos = await Promise.all(inventory.map((r) => readRepo($, r)))
    await update($, fleet, (f) => ({ ...f, repos, inventoryError: null, readAt: repos[0]?.readAt ?? f.readAt }))
  } catch (error) {
    // Nothing above should reject (each repository carries its own error); if the engine itself
    // does, the pane says so instead of keeping "remote: not read yet" for ever.
    await update($, fleet, (f) => ({ ...f, inventoryError: `refresh failed: ${why(error)}` }))
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
    if (refreshOnStart) void refreshRemote($, owner)

    return next(e)
  })

  on('command.run', { command: 'fleet' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'Fleet' })
    // With nothing shown yet, the local inventory is awaited so the pane has its rows at once;
    // the remote reading goes on in the background and writes the whole state when it lands.
    if ((await read($, fleet)).repos.length === 0) await loadInventory($, owner)
    void refreshRemote($, owner)

    return { text: 'Harness fleet opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    FleetView($.ui.resolve(e) as never, {
      fleet: await read($, fleet),
      lessons: await lessonsOf($),
      now: await $.clock.now(),
      onRefresh: () => void refreshRemote($, owner),
      onReview: (repo: string, pr: PrRow) => void $.prompt.submit({ text: reviewPrompt(repo, pr) }),
      onTake: (repo: string, issue: IssueRow) => void $.prompt.submit({ text: takeIssuePrompt(repo, issue) }),
      onDraftIssue: () =>
        void (async () => {
          const f = await read($, fleet)
          const repos = f.repos.map((r) => r.repo).filter((r): r is string => r !== null)
          await $.prompt.submit({ text: draftIssuePrompt(repos, await lessonsOf($)) })
        })(),
    }),
  )
}
