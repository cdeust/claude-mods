// The fleet: the owner's plugins, where each is installed from, and what its repository holds.

export type PluginRow = {
  name: string
  installed: string
  offered: string | null
  isBehind: boolean
}

export type CiState = 'success' | 'failure' | 'pending' | 'none'

export type PrRow = {
  number: number
  title: string
  isDraft: boolean
  updatedAt: string
  url: string
  ci: CiState
}

export type IssueRow = {
  number: number
  title: string
  labels: string[]
  createdAt: string
  comments: number
  url: string
}

export type RepoRow = {
  // owner/name on GitHub; null until a local marketplace's remote is resolved.
  repo: string | null
  // the local checkout a directory marketplace reads from; null for a GitHub marketplace.
  local: string | null
  marketplace: string
  marketplaceUpdatedAt: string | null
  plugins: PluginRow[]
  prs: PrRow[]
  // the open issues, newest 100 at most; null when the gh reading failed (never an empty list).
  issues: IssueRow[] | null
  error: string | null
  readAt: number | null
}

export type FleetState = {
  repos: RepoRow[]
  inventoryError: string | null
  isRefreshing: boolean
  readAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'harness-fleet': {
      fleet: FleetState
    }
  }
}
