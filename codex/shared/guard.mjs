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
// first word after `add` that is not an option and not an option's value (-b/-B/--orphan).
const pathAfterAdd = (t          , sub        )                     => {
  const args = t.slice(sub + 2)
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

export const worktreeAddPath = (command        )                     => {
  const t = tokensOf(command)
  const at = worktreeAddAt(t)?.sub
  return at === undefined ? undefined : pathAfterAdd(t, at)
}

// source: POSIX absolute (`/`), Windows drive (`C:\`, `C:/`) and UNC (`\\host`) spellings.
const isAbsolute = (path        )          => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path)

// One simple command of a shell line, the words with their quotes resolved, and what opened it: '' for the
// first, else the separator before it (`;` `&&` `||` `|` `&` newline, `(` `$(` and a backtick opening a group or
// a substitution, `)`). `body` is the text of the here-documents it carries.
                                                                 

// The command's simple commands, split at the shell's separators outside quotes (bash(1) SHELL GRAMMAR), not on
// whitespace: `true;cd sub` and `echo x &&cd sub` are separate commands. A here-document body is attached to the
// command that opens it, a comment is dropped, and `open` says a quote never closed (the split cannot be trusted
// then). A backslash outside quotes is literal (it is a Windows path separator here), so `\"` outside quotes is
// not understood; inside double quotes it escapes. Not parsed: `$(` inside double quotes (opaque text), brace
// groups (`{` is a word), line continuations.
export const shellSteps = (command        )                                   => {
  const steps         = []
  let sep = ''
  let words           = []
  let word                    
  let body = ''
  let quote                    
  let heredocs                                     = []
  const endWord = ()       => {
    if (word !== undefined) words.push(word)
    word = undefined
  }
  const endStep = (next        )       => {
    endWord()
    if (words.length > 0 || body !== '') steps.push({ sep, words, body })
    sep = next
    words = []
    body = ''
  }
  const n = command.length
  for (let i = 0; i < n; i++) {
    const c = command[i] ?? ''
    if (quote !== undefined) {
      if (c === quote) quote = undefined
      else if (quote === '"' && c === '\\' && i + 1 < n) word = (word ?? '') + (command[++i] ?? '')
      else word = (word ?? '') + c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      word ??= ''
    } else if (c === '#' && word === undefined) {
      while (i + 1 < n && command[i + 1] !== '\n') i++
    } else if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      const m = /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|([^\s;&|()<>]+))/.exec(command.slice(i))
      if (m === null) {
        word = (word ?? '') + c
        continue
      }
      endWord()
      heredocs.push({ delim: m[2] ?? m[3] ?? m[4] ?? '', tabs: m[1] === '-' })
      i += m[0].length - 1
    } else if (c === '\n') {
      let pos = i + 1
      for (const h of heredocs) {
        while (pos < n) {
          const eol = command.indexOf('\n', pos)
          const line = command.slice(pos, eol === -1 ? n : eol)
          body += `${line}\n`
          pos = eol === -1 ? n : eol + 1
          if ((h.tabs ? line.replace(/^\t+/, '') : line) === h.delim) break
        }
      }
      heredocs = []
      i = pos - 1
      endStep('\n')
    } else if (c === ';' || c === '(' || c === ')' || c === '`') endStep(c)
    else if (c === '$' && command[i + 1] === '(') {
      endStep('$(')
      i++
    } else if (c === '&' && command[i - 1] !== '>' && command[i - 1] !== '<' && command[i + 1] !== '>') {
      const twice = command[i + 1] === '&'
      endStep(twice ? '&&' : '&')
      if (twice) i++
    } else if (c === '|') {
      const twice = command[i + 1] === '|'
      endStep(twice ? '||' : '|')
      if (twice) i++
    } else if (/\s/.test(c)) endWord()
    else word = (word ?? '') + c
  }
  endStep('')

  return { steps, open: quote !== undefined }
}

// The builtins that move a shell's directory (bash(1) SHELL BUILTIN COMMANDS: cd, pushd, popd; chdir in
// some shells).
const DIR_CHANGE = /^(cd|pushd|popd|chdir)$/

// source: bash(1) RESERVED WORDS: they open a command without being it (`{ cd x; ...}`, `if cd x; then`).
const RESERVED = new Set(['{', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time'])

// The word that names the command a step runs.
const headOf = (step      )         => step.words.find((w) => !RESERVED.has(w)) ?? ''

// Commands that carry text without running it: a message, a body, a search pattern, an echo. A phrase found
// only inside the words of one of these is a mention. Any other command (`sh -c`, `eval`, `xargs`, `ssh`) may
// run its text, so a phrase inside it is not a mention. The list is closed on purpose: a command not on it is
// reported, never assumed harmless.
const TEXT_CARRIERS = new Set(['echo', 'printf', 'cat', 'grep', 'rg', 'gh'])
const TEXT_GIT = new Set(['commit', 'tag', 'notes'])
const carriesText = (step      )          => {
  const head = headOf(step)
  if (TEXT_CARRIERS.has(head)) return true
  if (head !== 'git') return false

  return TEXT_GIT.has(step.words[gitSubcommandIndex(step.words, step.words.indexOf('git'))] ?? '')
}

// `base` and `rel` joined, `.` segments dropped; `..` is left for the file system to fold (a link before it
// lands elsewhere than a lexical fold says).
const joinPath = (base        , rel        )         =>
  `${base.replace(/[\\/]+$/, '')}/${rel}`.split('/').filter((segment) => segment !== '.').join('/')

// `path` is where the worktree lands; `reason` is why that is not known; `mention` is a command that names the
// phrase only as text (nothing ran).
                                                                                

const PHRASE = /\bworktree\s+add\b/

// Where the worktree a `git worktree add` names lands, from the command text and the directory the shell
// starts in (`cwd`, the session's; undefined when it could not be read; `agentId` is set inside a subagent's
// loop). A relative path is the shell's when git runs: the start directory, or the one a leading `cd <dir>`
// took it to when every command from that cd to git is joined by `&&` (git runs only once each succeeded, and
// none of them is itself a directory change). Any other directory change before git, a `git -C`, a `~` or a
// variable, a path with a space or an unclosed quote leaves it unknown, and the answer is the reason, never a
// guess. `added` is the path the refusal rule judged; it only names the path in a reason.
export const placeWorktreeAdd = (command        , added        , cwd                    , agentId         )           => {
  const unknown = (why        )           => ({ reason: `the path ${added} could not be resolved: ${why}` })
  const { steps, open } = shellSteps(command)
  if (open) return unknown('a quote in the command is not closed')
  const k = steps.findIndex((step) => worktreeAddAt(step.words) !== undefined)
  if (k === -1) {
    const named = steps.filter((step) => PHRASE.test([...step.words, step.body].join(' ')))
    const runner = named.find((step) => !carriesText(step))
    if (named.length > 0 && runner === undefined) return { mention: true }
    return unknown(
      runner === undefined ? 'no git worktree add was found at a command position' : `the phrase is inside text that ${headOf(runner)} may run`,
    )
  }
  const step = steps[k]        
  const at = worktreeAddAt(step.words)                                
  const path = pathAfterAdd(step.words, at.sub)
  if (path === undefined) return unknown('the add names no path')
  if (/\s/.test(path)) return unknown('the path has a space in it')
  if (/^~|[$`]/.test(path)) return unknown('the shell expands it')
  if (isAbsolute(path)) return { path }
  if (step.words.slice(at.git + 1, at.sub).includes('-C')) return unknown('git -C changes the directory it is relative to')
  const before = steps.slice(0, k)
  const moved = before.filter((s) => DIR_CHANGE.test(headOf(s)))
  let start = cwd
  let fromCwd = true
  const lead = before[0]
  if (moved.length > 0) {
    const chained = steps.slice(1, k + 1).every((s) => s.sep === '&&')
    if (lead === undefined || moved.length !== 1 ||lead.sep !== '' || !chained || lead.words.length !== 2 || lead.words[0] !== 'cd')
      return unknown(`the shell's directory is changed before git runs (${headOf(moved[0]        )})`)
    const dir = lead.words[1] ?? ''
    if (dir === '' || /^[~-]|[$`\s]/.test(dir)) return unknown(`the shell's directory is changed to ${dir || 'its home'} before git runs`)
    if (isAbsolute(dir)) {
      start = dir
      fromCwd = false
    } else start = cwd === undefined ? undefined : joinPath(cwd, dir)
  }
  if (fromCwd && agentId !== undefined) return unknown("a subagent's shell may start in another directory than the session's")
  if (start === undefined) return unknown("the session's directory could not be read")

  return { path: joinPath(start, path) }
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
