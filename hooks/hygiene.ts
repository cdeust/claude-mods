import type { Worktree } from '../types'
import { isInsideWorktreeRoot } from './guard'

// source: ~/.local/state/disk-hygiene/ownership.json, the registry disk_hygiene.py keeps
// (its --state default); one entry per registered path, `owner` is "<host>:<session>".
export const OWNERSHIP_PATH = '~/.local/state/disk-hygiene/ownership.json'

export type Ownership = Record<string, { owner?: string; pr?: string; kind?: string }>

export const parseOwnership = (text: string): Ownership | undefined => {
  try {
    const raw = JSON.parse(text) as unknown
    return raw !== null && typeof raw === 'object' ? (raw as Ownership) : undefined
  } catch {
    return undefined
  }
}

// `git worktree list --porcelain`: stanzas separated by a blank line, the first is main.
export const parsePorcelain = (text: string): { path: string; branch: string | null }[] =>
  text
    .split(/\n\s*\n/)
    .map((stanza) => stanza.trim())
    .filter((stanza) => stanza.startsWith('worktree '))
    .map((stanza) => {
      const lines = stanza.split('\n')
      const path = (lines[0] ?? '').slice('worktree '.length)
      const branch = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length) ?? null
      return { path, branch }
    })

export const worktrees = (porcelain: string, ownership: Ownership | undefined): Worktree[] =>
  parsePorcelain(porcelain).map((w, i) => {
    const entry = ownership?.[w.path]
    return {
      path: w.path,
      branch: w.branch,
      isMain: i === 0,
      isInsideRepoRule: i === 0 || isInsideWorktreeRoot(w.path),
      isRegistered: entry !== undefined,
      owner: entry?.owner ?? null,
      pr: entry?.pr ?? null,
    }
  })

// source: the test runners the Cortex and ai-architect projects use (pytest, vitest, cargo).
const TEST_RUNNER = /\b(pytest|vitest|jest|cargo test|go test|mutmut|hypothesis)\b/

// `ps -eo pid,etime,command` rows that are a test runner; the header row never matches.
export const testProcesses = (
  ps: string,
): { pid: number; elapsed: string; command: string }[] =>
  ps
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => TEST_RUNNER.test(line) && !/\bgrep\b/.test(line))
    .map((line) => {
      const [pid, elapsed, ...rest] = line.split(/\s+/)
      return { pid: Number(pid), elapsed: elapsed ?? '', command: rest.join(' ').slice(0, 80) }
    })
    .filter((p) => Number.isFinite(p.pid))

export const shortPath = (path: string, repo: string): string =>
  path.startsWith(repo) ? path.slice(repo.length).replace(/^\//, '') || '.' : path
