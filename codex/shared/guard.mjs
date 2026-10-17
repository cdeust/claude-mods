// Generated from mods/cortex-guard/hooks/guard.ts; run npm run build:codex.
// Pure verdicts for the two rules no settings hook enforces: wiki pages are written only
// through the wiki tool, and every git worktree lives inside the repo.

import { isInsideWorktreeRoot, withSlashes } from './rules.mjs'

// source: the generated mirrors carry "Read-only mirror: edit the canonical wiki page"
// (docs/adr/ADR-1060-*.md header); the canonical pages live under wiki/ (wiki/README.md).
const MIRROR = /(^|\/)docs\/adr\/ADR-\d+[^/]*\.md$/
const CANONICAL = /(^|\/)wiki\/(adr|specs|lessons)\/.+\.md$/

                                                                                      

const ALLOW          = { allow: true }

export const WIKI_RULE = 'wiki-write-only'
export const WORKTREE_RULE = 'worktree-inside-repo'

const refuseWiki = (path        , why        )          => ({
  allow: false,
  rule: WIKI_RULE,
  reason: `${path}: ${why} Use the Cortex wiki_write tool (wiki_adr for a decision); wiki_reindex regenerates the mirror.`,
})

// The patterns are written with `/`; a Windows path is matched in its slashed spelling and reported
// as it was typed.
export const judgePath = (path        )          => {
  const slashed = withSlashes(path)
  if (MIRROR.test(slashed)) return refuseWiki(path, 'a generated read-only mirror.')
  if (CANONICAL.test(slashed))
    return refuseWiki(path, 'a canonical wiki page, written only through the wiki tool.')
  return ALLOW
}

const WRITES_FILES = /(^|[\s;&|(])(sed\s+-i|tee|cp|mv|rm|truncate|dd|perl\s+-pi)\b|>>?\s*\S/

const tokensOf = (command        )           =>
  command.split(/\s+/).map((t) => t.replace(/^['"]|['"]$/g, ''))

// Best effort: a shell command that names a protected path and writes.
export const judgeShellWiki = (command        )          => {
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
const gitSubcommandIndex = (t          , at        )         => {
  let i = at + 1
  while (i < t.length && (t[i] ?? '').startsWith('-')) {
    i += GIT_VALUED_OPTIONS.has(t[i] ?? '') ? 2 : 1
  }
  return i
}

// Where the `git ... worktree add` is in the tokens: the index of `git` and of `worktree`.
const worktreeAddAt = (t          )                                           => {
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== 'git') continue
    const sub = gitSubcommandIndex(t, i)
    if (t[sub] === 'worktree' && t[sub + 1] === 'add') return { git: i, sub }
  }
  return undefined
}

// `git [global options] worktree add [options] <path> [<commit-ish>]`: the path is the
// first token after `add` that is not an option and not an option's value (-b/-B/--orphan).
export const worktreeAddPath = (command        )                     => {
  const t = tokensOf(command)
  const at = worktreeAddAt(t)?.sub
  if (at === undefined) return undefined
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

// source: POSIX absolute (`/`), Windows drive (`C:\`, `C:/`) and UNC (`\\host`) spellings.
const isAbsolute = (path        )          => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path)

// The builtins that move a shell's directory (bash(1) SHELL BUILTIN COMMANDS: cd, pushd, popd; chdir in
// some shells), as a token or opening a subshell, a substitution or a group.
const DIR_CHANGE = /^[$({]*(cd|pushd|popd|chdir)$/

// `base` and `rel` joined, `.` segments dropped; `..` is left for the file system to fold (a link before it
// lands elsewhere than a lexical fold says).
const joinPath = (base        , rel        )         =>
  `${base.replace(/[\\/]+$/, '')}/${rel}`.split('/').filter((segment) => segment !== '.').join('/')

                                                            

// Where the worktree a `git worktree add` names lands, from the command text and the directory the shell
// starts in (`cwd`, the session's; undefined when it could not be read). A relative path is the shell's
// when git runs: the start directory, or the one a leading `cd <dir> &&` took it to (`&&`: git runs only
// once the cd succeeded). Any other directory change before git, a `git -C`, a `~` or a variable leaves
// it unknown, and the answer is the reason, never a guess.
export const placeWorktreeAdd = (command        , added        , cwd                    )           => {
  if (isAbsolute(added)) return { path: added }
  const unknown = (why        )           => ({ reason: `the path ${added} could not be resolved: ${why}` })
  if (/^[~$]/.test(added)) return unknown('the shell expands it')
  const t = tokensOf(command)
  const at = worktreeAddAt(t)
  if (at === undefined) return unknown('no git worktree add was found in the command')
  if (t.slice(at.git + 1, at.sub).includes('-C')) return unknown('git -C changes the directory it is relative to')
  const before = t.slice(0, at.git)
  let start = cwd
  if (before.length === 3 && before[0] === 'cd' && before[2] === '&&') {
    const dir = before[1] ?? ''
    if (dir === '' || dir === '-' || /^[~$]/.test(dir)) return unknown(`the shell's directory is changed to ${dir || 'its home'} before git runs`)
    start = isAbsolute(dir) ? dir : cwd === undefined ? undefined : joinPath(cwd, dir)
  } else {
    const change = before.find((token) => DIR_CHANGE.test(token))
    if (change !== undefined) return unknown(`the shell's directory is changed before git runs (${change})`)
  }
  if (start === undefined) return unknown("the session's directory could not be read")

  return { path: joinPath(start, added) }
}

export const judgeShellWorktree = (command        )          => {
  const path = worktreeAddPath(command)
  if (path === undefined || isInsideWorktreeRoot(path)) return ALLOW
  return {
    allow: false,
    rule: WORKTREE_RULE,
    reason: `git worktree add ${path}: a worktree lives at <repo>/.claude/worktrees/<name>/ (.Codex/worktrees/ for Codex), never outside the repo.`,
  }
}

export const judgeShell = (command        )          => {
  const wiki = judgeShellWiki(command)
  return wiki.allow ? judgeShellWorktree(command) : wiki
}

                                                                                        

export const judgeCall = (tool        , input           )          => {
  if ((tool === 'Edit' || tool === 'Write') && input.file_path !== undefined)
    return judgePath(input.file_path)
  if (tool === 'NotebookEdit' && input.notebook_path !== undefined)
    return judgePath(input.notebook_path)
  if (tool === 'Bash' && input.command !== undefined) return judgeShell(input.command)
  return ALLOW
}
