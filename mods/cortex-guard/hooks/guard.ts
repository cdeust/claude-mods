// Pure verdicts for the two rules no settings hook enforces: wiki pages are written only
// through the wiki tool, and every git worktree lives inside the repo.

import { isInsideWorktreeRoot, withSlashes } from './rules'

// source: the generated mirrors carry "Read-only mirror: edit the canonical wiki page"
// (docs/adr/ADR-1060-*.md header); the canonical pages live under wiki/ (wiki/README.md).
const MIRROR = /(^|\/)docs\/adr\/ADR-\d+[^/]*\.md$/
const CANONICAL = /(^|\/)wiki\/(adr|specs|lessons)\/.+\.md$/

export type Verdict = { allow: true } | { allow: false; rule: string; reason: string }

const ALLOW: Verdict = { allow: true }

export const WIKI_RULE = 'wiki-write-only'
export const WORKTREE_RULE = 'worktree-inside-repo'

const refuseWiki = (path: string, why: string): Verdict => ({
  allow: false,
  rule: WIKI_RULE,
  reason: `${path}: ${why} Use the Cortex wiki_write tool (wiki_adr for a decision); wiki_reindex regenerates the mirror.`,
})

// The patterns are written with `/`; a Windows path is matched in its slashed spelling and reported
// as it was typed.
export const judgePath = (path: string): Verdict => {
  const slashed = withSlashes(path)
  if (MIRROR.test(slashed)) return refuseWiki(path, 'a generated read-only mirror.')
  if (CANONICAL.test(slashed))
    return refuseWiki(path, 'a canonical wiki page, written only through the wiki tool.')
  return ALLOW
}

const WRITES_FILES = /(^|[\s;&|(])(sed\s+-i|tee|cp|mv|rm|truncate|dd|perl\s+-pi)\b|>>?\s*\S/

const tokensOf = (command: string): string[] =>
  command.split(/\s+/).map((t) => t.replace(/^['"]|['"]$/g, ''))

// Best effort: a shell command that names a protected path and writes.
export const judgeShellWiki = (command: string): Verdict => {
  if (!WRITES_FILES.test(command)) return ALLOW
  for (const path of tokensOf(command)) {
    const verdict = judgePath(path)
    if (!verdict.allow) return verdict
  }
  return ALLOW
}

// source: `git [-C <path>] [-c <name>=<value>] [--git-dir=<path>|--git-dir <path>] ...
// <command>` (git(1) SYNOPSIS); these global options take a value when given separately.
const GIT_VALUED_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])

// Index of the subcommand after `git` at `at`, skipping git's own global options.
const gitSubcommandIndex = (t: string[], at: number): number => {
  let i = at + 1
  while (i < t.length && (t[i] ?? '').startsWith('-')) {
    i += GIT_VALUED_OPTIONS.has(t[i] ?? '') ? 2 : 1
  }
  return i
}

// `git [global options] worktree add [options] <path> [<commit-ish>]`: the path is the
// first token after `add` that is not an option and not an option's value (-b/-B/--orphan).
export const worktreeAddPath = (command: string): string | undefined => {
  const t = tokensOf(command)
  let at = -1
  for (let i = 0; i < t.length && at < 0; i++) {
    if (t[i] !== 'git') continue
    const sub = gitSubcommandIndex(t, i)
    if (t[sub] === 'worktree' && t[sub + 1] === 'add') at = sub
  }
  if (at < 0) return undefined
  const args = t.slice(at + 2)
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (a === '-b' || a === '-B' || a === '--orphan') {
      i++
      continue
    }
    if (a.startsWith('-')) continue
    return a
  }
  return undefined
}

export const judgeShellWorktree = (command: string): Verdict => {
  const path = worktreeAddPath(command)
  if (path === undefined || isInsideWorktreeRoot(path)) return ALLOW
  return {
    allow: false,
    rule: WORKTREE_RULE,
    reason: `git worktree add ${path}: a worktree lives at <repo>/.claude/worktrees/<name>/ (.Codex/worktrees/ for Codex), never outside the repo.`,
  }
}

export const judgeShell = (command: string): Verdict => {
  const wiki = judgeShellWiki(command)
  return wiki.allow ? judgeShellWorktree(command) : wiki
}

export type CallInput = { file_path?: string; command?: string; notebook_path?: string }

export const judgeCall = (tool: string, input: CallInput): Verdict => {
  if ((tool === 'Edit' || tool === 'Write') && input.file_path !== undefined)
    return judgePath(input.file_path)
  if (tool === 'NotebookEdit' && input.notebook_path !== undefined)
    return judgePath(input.notebook_path)
  if (tool === 'Bash' && input.command !== undefined) return judgeShell(input.command)
  return ALLOW
}
