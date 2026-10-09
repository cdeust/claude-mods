// Pure side of the fleet: the engine's plugin records, the marketplaces' manifests and gh's JSON
// become rows; the prompts a Button puts in front of the model are composed here.

import type { CiState, IssueRow, PluginRow, PrRow, RepoRow } from '../types'

// source: ~/.claude/plugins/installed_plugins.json and known_marketplaces.json, the engine's
// records (read 2026-10-08): plugins["<name>@<marketplace>"][0].{version, installPath};
// marketplaces[<name>].{source:{source:"github",repo}|{source:"directory",path}, installLocation,
// lastUpdated}. A marketplace's own manifest is <installLocation>/.claude-plugin/marketplace.json,
// plugins[].{name, version}.
export const INSTALLED_PLUGINS_PATH = '~/.claude/plugins/installed_plugins.json'
export const KNOWN_MARKETPLACES_PATH = '~/.claude/plugins/known_marketplaces.json'
export const MARKETPLACE_MANIFEST = '.claude-plugin/marketplace.json'

export type Installed = { name: string; marketplace: string; version: string }
export type Marketplace = {
  name: string
  repo: string | null
  path: string | null
  installLocation: string
  lastUpdated: string | null
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export const parseInstalled = (json: string): Installed[] => {
  const d = parseJson(json) as { plugins?: Record<string, { version?: unknown }[]> } | undefined
  return Object.entries(d?.plugins ?? {}).flatMap(([key, entries]) => {
    const at = key.lastIndexOf('@')
    const version = entries[0]?.version
    if (at <= 0 || typeof version !== 'string') return []
    return [{ name: key.slice(0, at), marketplace: key.slice(at + 1), version }]
  })
}

export const parseMarketplaces = (json: string): Marketplace[] => {
  const d = parseJson(json) as
    | Record<string, { source?: { source?: string; repo?: string; path?: string }; installLocation?: string; lastUpdated?: string }>
    | undefined
  return Object.entries(d ?? {}).flatMap(([name, m]) => {
    if (typeof m.installLocation !== 'string') return []
    const src = m.source ?? {}
    return [
      {
        name,
        repo: src.source === 'github' && typeof src.repo === 'string' ? src.repo : null,
        path: src.source === 'directory' && typeof src.path === 'string' ? src.path : null,
        installLocation: m.installLocation,
        lastUpdated: typeof m.lastUpdated === 'string' ? m.lastUpdated : null,
      },
    ]
  })
}

// plugin name → the version the marketplace offers.
export const parseOffered = (manifestJson: string): Record<string, string> => {
  const d = parseJson(manifestJson) as { plugins?: { name?: unknown; version?: unknown }[] } | undefined
  const out: Record<string, string> = {}
  for (const p of d?.plugins ?? []) if (typeof p.name === 'string' && typeof p.version === 'string') out[p.name] = p.version
  return out
}

// Numeric dot-separated versions compare field by field; anything else compares as text.
export const isBehind = (installed: string, offered: string | null): boolean => {
  if (offered === null || installed === offered) return false
  const a = installed.split('.').map(Number)
  const b = offered.split('.').map(Number)
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return installed < offered
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x < y
  }
  return false
}

// The owner's repositories alone: a GitHub marketplace under the owner, or a local directory.
export const isOwned = (m: Marketplace, owner: string): boolean =>
  m.path !== null || (m.repo !== null && m.repo.toLowerCase().startsWith(`${owner.toLowerCase()}/`))

export const fleetRows = (
  installed: readonly Installed[],
  marketplaces: readonly Marketplace[],
  offered: Readonly<Record<string, Record<string, string>>>,
  owner: string,
): RepoRow[] =>
  marketplaces
    .filter((m) => isOwned(m, owner))
    .map((m) => {
      const plugins: PluginRow[] = installed
        .filter((p) => p.marketplace === m.name)
        .map((p) => {
          const off = offered[m.name]?.[p.name] ?? null
          return { name: p.name, installed: p.version, offered: off, isBehind: isBehind(p.version, off) }
        })
      return {
        repo: m.repo,
        local: m.path,
        marketplace: m.name,
        marketplaceUpdatedAt: m.lastUpdated,
        plugins,
        prs: [],
        issues: null,
        error: null,
        readAt: null,
      }
    })
    .filter((r) => r.plugins.length > 0)

// `git remote get-url origin` → owner/name, for a directory marketplace.
export const repoOfRemote = (url: string): string | null => {
  const m = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/.exec(url.trim())
  return m === null ? null : (m[1] ?? null)
}

// source: `gh pr list --json statusCheckRollup` (read on cdeust/Cortex, 2026-10-08): CheckRun rows
// carry status (COMPLETED, IN_PROGRESS, QUEUED, ...) and conclusion (SUCCESS, FAILURE, CANCELLED,
// SKIPPED, NEUTRAL, TIMED_OUT, ACTION_REQUIRED, null while running); StatusContext rows carry
// state (SUCCESS, FAILURE, ERROR, PENDING, EXPECTED). An empty list is no check, not green.
type Rollup = { __typename?: string; status?: string; conclusion?: string | null; state?: string }

const RED = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const IGNORED = new Set(['SKIPPED', 'NEUTRAL'])

export const ciOf = (rollup: readonly Rollup[]): CiState => {
  if (rollup.length === 0) return 'none'
  let hasGreen = false
  let isPending = false
  for (const r of rollup) {
    const verdict = r.__typename === 'StatusContext' ? r.state : r.conclusion
    if (r.__typename !== 'StatusContext' && r.status !== undefined && r.status !== 'COMPLETED') {
      isPending = true
      continue
    }
    if (verdict === undefined || verdict === null || verdict === 'PENDING' || verdict === 'EXPECTED') {
      isPending = true
      continue
    }
    if (RED.has(verdict)) return 'failure'
    if (verdict === 'SUCCESS') hasGreen = true
    else if (!IGNORED.has(verdict)) isPending = true
  }
  if (isPending) return 'pending'
  return hasGreen ? 'success' : 'none'
}

export const parsePrList = (json: string): PrRow[] => {
  const d = parseJson(json)
  if (!Array.isArray(d)) return []
  return d.flatMap((p: Record<string, unknown>) =>
    typeof p.number === 'number' && typeof p.title === 'string'
      ? [
          {
            number: p.number,
            title: p.title,
            isDraft: p.isDraft === true,
            updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : '',
            url: typeof p.url === 'string' ? p.url : '',
            ci: ciOf(Array.isArray(p.statusCheckRollup) ? (p.statusCheckRollup as Rollup[]) : []),
          },
        ]
      : [],
  )
}

export const parseIssues = (json: string): IssueRow[] | null => {
  const d = parseJson(json)
  if (!Array.isArray(d)) return null
  return d.flatMap((i: Record<string, unknown>) =>
    typeof i.number === 'number' && typeof i.title === 'string'
      ? [
          {
            number: i.number,
            title: i.title,
            labels: Array.isArray(i.labels) ? i.labels.flatMap((l: { name?: unknown }) => (typeof l.name === 'string' ? [l.name] : [])) : [],
            createdAt: typeof i.createdAt === 'string' ? i.createdAt : '',
            comments: Array.isArray(i.comments) ? i.comments.length : 0,
            url: typeof i.url === 'string' ? i.url : '',
          },
        ]
      : [],
  )
}

// source: the owner's standing rule (model-behavior.md): repair work is taken and finished
// without asking; only adding a feature needs the owner's arbitration. A label that names a
// request (not a defect) therefore routes the issue to an assessment, never to a fix.
const FEATURE_LABELS = new Set(['enhancement', 'feature', 'feature request', 'question', 'proposal'])
export type IssueKind = 'defect' | 'feature'
export const issueKind = (labels: readonly string[]): IssueKind =>
  labels.some((l) => FEATURE_LABELS.has(l.toLowerCase())) ? 'feature' : 'defect'

// The read-only gh and git calls the mod makes; nothing here writes anywhere.
export const PR_LIMIT = 10 // source: own choice, the newest open PRs a pane row can carry
export const ISSUE_LIMIT = 100 // source: own choice, past it the count reads "100+"
export const prListArgv = (repo: string): string[] => [
  'gh', 'pr', 'list', '--repo', repo, '--state', 'open', '--json',
  'number,title,isDraft,updatedAt,url,statusCheckRollup', '--limit', String(PR_LIMIT),
]
export const issueListArgv = (repo: string): string[] => [
  'gh', 'issue', 'list', '--repo', repo, '--state', 'open', '--json', 'number,title,labels,createdAt,url,comments',
  '--limit', String(ISSUE_LIMIT),
]
export const remoteArgv = (local: string): string[] => ['git', '-C', local, 'remote', 'get-url', 'origin']

// What a Button puts in front of the model. The rules named are the owner's standing ones: the
// lead posts the verdict as a standalone comment with the head sha on line 2; a merge goes
// through merge-gate.py with --repo; every worktree lives inside the repo and is registered.
export const reviewPrompt = (repo: string, pr: PrRow): string =>
  [
    `Review PR #${pr.number} of ${repo} ("${pr.title}", CI ${pr.ci}).`,
    'Read the diff and the CI logs for any red check. Post the review verdict as the lead: a standalone `gh pr comment` whose line 2 is the head sha.',
    'Merge only through merge-gate.py with --repo, and only when CI is green and the verdict is posted. Never merge, close or push from a mod.',
  ].join(' ')

export const takeIssuePrompt = (repo: string, issue: IssueRow): string =>
  issueKind(issue.labels) === 'feature'
    ? [
        `Issue #${issue.number} of ${repo} ("${issue.title}") is a feature request.`,
        "Adding a feature needs the owner's decision: read the issue and its comments, then state in three sentences what it would change, what it costs and the alternative, and wait for the owner's answer before writing any code.",
      ].join(' ')
    : [
        `Take issue #${issue.number} of ${repo} ("${issue.title}", ${issue.labels.length === 0 ? 'no label' : issue.labels.join(', ')}, ${issue.comments} comment${issue.comments === 1 ? '' : 's'}).`,
        'Read the issue and its comments, reproduce the defect on current main with a test that fails before the fix, fix the root cause in a worktree under <repo>/.claude/worktrees/ registered with disk-hygiene, run the gates exactly as CI runs them, and open a PR that closes it.',
        'Have the PR reviewed independently and merge only through merge-gate.py with --repo, once CI is green and the verdict is posted.',
        'Never close an issue without evidence: if the defect cannot be reproduced, say so with the commands run and ask the reporter on the issue.',
      ].join(' ')

export type Lessons = { refusals: number; classifierErrors: number; stuckEscalations: number; leanCuts: number }

export const draftIssuePrompt = (repos: readonly string[], l: Lessons): string =>
  [
    'From this session\'s harness signals, draft one GitHub issue on the plugin repository the signal belongs to:',
    `${l.refusals} guard refusals, ${l.classifierErrors} classifier errors, ${l.stuckEscalations} stuck escalations, ${l.leanCuts} tool results cut.`,
    `Candidate repositories: ${repos.join(', ')}.`,
    'Show me the issue title and body first; create it with `gh issue create` only after I confirm.',
  ].join(' ')
