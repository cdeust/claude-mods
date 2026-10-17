// Pure verdicts for the two rules no settings hook enforces: wiki pages are written only
// through the wiki tool, and every git worktree lives inside the repo.

import { WORKTREE_ROOTS, withSlashes } from './rules'

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

// Whitespace words with their outer quotes dropped: the wiki rule's best effort, and the words of prose that
// mentions a worktree add (a message is not shell: an apostrophe in it is not a quote).
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

// source: `git [-C <path>] [-c <name>=<value>] [--git-dir=<path>] [--config-env=<name>=<envvar>] ... <command>`
// (git(1) SYNOPSIS); these global options take a value when given separately.
const GIT_VALUED_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])

// Index of the subcommand after `git` at `at`, skipping git's own global options.
const gitSubcommandIndex = (t: string[], at: number): number => {
  let i = at + 1
  while (i < t.length && (t[i] ?? '').startsWith('-')) {
    i += GIT_VALUED_OPTIONS.has(t[i] ?? '') ? 2 : 1
  }
  return i
}

// The name a command word runs: a backslash in it only escapes (`\git` runs git); a path keeps its backslashes,
// a command name has none.
const nameOf = (word: string | undefined): string => (word ?? '').replace(/\\/g, '')

// source: git-worktree(1) as git 2.50 prints it (`git worktree add -h`): `[-f] [--detach] [--checkout] [--lock
// [--reason <string>]] [--orphan] [(-b | -B) <new-branch>] <path> [<commit-ish>]`. -b and -B take a value, glued
// (`-bname`) or next, also at the end of a cluster (`-fb name`); --reason takes the next word, and git accepts an
// unambiguous prefix of it (`--rea`; `--re` is also --relative-paths); --orphan takes none; `--` ends the options.
// The path is the first other word.
const pathAfterAdd = (t: string[], sub: number): string | undefined => {
  const args = t.slice(sub + 2)
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (a === '--') return args[i + 1]
    if (a.startsWith('--')) {
      const name = a.slice(2)
      if (!name.includes('=') && name.length >= 3 && 'reason'.startsWith(name)) i++
      continue
    }
    if (a.startsWith('-') && a.length > 1) {
      const valued = [...a.slice(1)].findIndex((flag) => flag === 'b' || flag === 'B')
      if (valued !== -1 && valued === a.length - 2) i++
      continue
    }
    return a
  }
  return undefined
}

// source: POSIX absolute (`/`), Windows drive (`C:\`, `C:/`) and UNC (`\\host`) spellings.
const isAbsolute = (path: string): boolean => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path)

// Whether a worktree created at `path` lands at <somewhere>/.claude/worktrees/<name> (or .Codex/): a relative path
// is read from a root (`.claude/worktrees/x` from the repo is as inside as `./.claude/worktrees/x`); what follows the
// last worktree root must name a directory, never `..` out of it nor a part the shell expands.
const landsInWorktreeRoot = (path: string): boolean => {
  const slashed = withSlashes(isAbsolute(path) ? path : `/${path}`)
  const at = Math.max(
    ...WORKTREE_ROOTS.map((root) => {
      const found = slashed.lastIndexOf(root)
      return found === -1 ? -1 : found + root.length
    }),
  )
  if (at === -1) return false
  const tail = slashed.slice(at)
  const segments = tail.split('/').filter((segment) => segment !== '' && segment !== '.')

  return segments.length > 0 && !segments.includes('..') && !/[$`]/.test(tail)
}

// One simple command of a shell line: its words with the quotes resolved and the redirections taken out, what
// opened it ('' for the first, else the separator before it: `;` `&&` `||` `|` `&` newline, `(` a subshell, `)`,
// `$(` or a backtick a substitution), the here-documents it reads (`body`; `expands` when a delimiter was unquoted,
// so the shell runs the `$( )` and backticks in that body) and `owner`: the command a substitution's output is
// part of (undefined outside any substitution). A substitution's text stays in its owner's word as typed.
export type Step = { sep: string; words: string[]; body: string; expands: boolean; owner: Step | undefined }

// source: bash(1) REDIRECTION: `[n]>` `>>` `>|` `<` `<>` `>&` `<&`, and `&>` `&>>` (both outputs).
const REDIRECT = /^(?:&>>|&>|>>|>&|>\||<>|<&|>|<)/

// The command's simple commands, split at the shell's separators outside quotes (bash(1) SHELL GRAMMAR), not on
// whitespace: `true;git` is two commands. `$(`, a backtick and `<(`/`>(` open a substitution, outside quotes and
// inside double quotes alike, whose commands are steps of their own. A here-document's body is attached to the
// command that opened it, wherever that command is on its line. A comment is dropped. A backslash outside quotes
// is literal (a Windows path separator here) except before a newline (a line continuation); inside double quotes it
// escapes `$` `` ` `` `"` `\` and a newline. `open` says a quote or a substitution never closed: nothing read after
// it is sure.
export const shellSteps = (command: string): { steps: Step[]; open: boolean } => {
  const steps: Step[] = []
  const fresh = (sep: string, owner: Step | undefined): Step => ({ sep, words: [], body: '', expands: false, owner })
  type Frame = { kind: '(' | '$(' | '`'; step: Step; word: string | undefined; quote: string | undefined; target: boolean; start: number }
  const frames: Frame[] = []
  const readers = new Set<Step>()
  let docs: { owner: Step; delim: string; tabs: boolean; expands: boolean }[] = []
  let step = fresh('', undefined)
  let word: string | undefined
  let quote: string | undefined
  // The next word is a redirection's target, not a word of the command.
  let target = false
  const endWord = (): void => {
    if (word === undefined) return
    if (target) target = false
    else step.words.push(word)
    word = undefined
  }
  const endStep = (next: string): void => {
    endWord()
    target = false
    if (step.words.length > 0 || readers.has(step)) steps.push(step)
    step = fresh(next, step.owner)
  }
  const open = (kind: '$(' | '`', start: number): void => {
    frames.push({ kind, step, word, quote, target, start })
    step = fresh(kind, step)
    word = undefined
    quote = undefined
    target = false
  }
  const close = (frame: Frame, end: number): void => {
    endStep('')
    step = frame.step
    quote = frame.quote
    target = frame.target
    word = (frame.word ?? '') + command.slice(frame.start, end + 1)
  }
  const n = command.length
  for (let i = 0; i < n; i++) {
    const c = command[i] ?? ''
    const next = command[i + 1] ?? ''
    if (quote === "'") {
      if (c === "'") quote = undefined
      else word += c
    } else if (quote === '"') {
      if (c === '"') quote = undefined
      else if (c === '\\' && next !== '' && '$`"\\\n'.includes(next)) word += command[++i] ?? ''
      else if (c === '$' && next === '(') open('$(', i++)
      else if (c === '`') open('`', i)
      else word += c
    } else if (c === "'" || c === '"') {
      quote = c
      word ??= ''
    } else if (c === '\\' && next === '\n') i++
    else if (c === '#' && word === undefined) {
      while (i + 1 < n && command[i + 1] !== '\n') i++
    } else if (c === '<' && next === '<' && command[i + 2] !== '<') {
      const m = /^<<(-?)[ \t]*((?:'[^']*'|"[^"]*"|[^\s;&|()<>'"])+)/.exec(command.slice(i))
      if (m === null) {
        word = (word ?? '') + c
        continue
      }
      if (word !== undefined && /^\d+$/.test(word)) word = undefined
      else endWord()
      const raw = m[2] ?? ''
      docs.push({ owner: step, delim: raw.replace(/['"\\]/g, ''), tabs: m[1] === '-', expands: !/['"\\]/.test(raw) })
      readers.add(step)
      i += m[0].length - 1
    } else if (c === '\n') {
      let pos = i + 1
      for (const doc of docs) {
        while (pos < n) {
          const eol = command.indexOf('\n', pos)
          const line = command.slice(pos, eol === -1 ? n : eol)
          pos = eol === -1 ? n : eol + 1
          if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.delim) break
          doc.owner.body += `${line}\n`
        }
        doc.owner.expands ||= doc.expands
      }
      docs = []
      i = pos - 1
      endStep('\n')
    } else if (c === '`') {
      const top = frames.at(-1)
      if (top?.kind === '`') close(frames.pop() as Frame, i)
      else open('`', i)
    } else if ((c === '$' || c === '<' || c === '>') && next === '(') open('$(', i++)
    else if (c === '(') {
      frames.push({ kind: '(', step, word, quote, target, start: i })
      endStep('(')
    } else if (c === ')') {
      const top = frames.at(-1)
      if (top?.kind === '$(') close(frames.pop() as Frame, i)
      else {
        if (top?.kind === '(') frames.pop()
        endStep(')')
      }
    } else if (c === ';') endStep(';')
    else if (c === '<' && next === '<') {
      // A here-string (`<<<`): its word is text the command reads, kept with its words.
      endWord()
      i += 2
    } else if (c === '<' || c === '>' || (c === '&' && next === '>')) {
      if (c !== '&' && word !== undefined && /^\d+$/.test(word)) word = undefined
      else endWord()
      i += (REDIRECT.exec(command.slice(i))?.[0].length ?? 1) - 1
      target = true
    } else if (c === '&') {
      const twice = next === '&'
      endStep(twice ? '&&' : '&')
      if (twice) i++
    } else if (c === '|') {
      endStep(next === '|' ? '||' : '|')
      if (next === '|' || next === '&') i++
    } else if (/\s/.test(c)) endWord()
    else word = (word ?? '') + c
  }
  endStep('')

  return { steps, open: quote !== undefined || frames.some((frame) => frame.kind !== '(') }
}

// source: bash(1) RESERVED WORDS: they open or close a command without being it (`{ cd x; }`, `if cd x; then`).
const RESERVED = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'case', 'esac'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

// The words of the command a step runs, from its name on, once the reserved words, the variable assignments and the
// commands that run the rest of their words are skipped (bash(1) SHELL BUILTIN COMMANDS: builtin, command, exec,
// time; env(1), nohup(1), nice(1), timeout(1)). `chdir` is the directory `env -C` runs it in. `env -S` splits a
// string into a command: env is the command then (the string is not read). `outside` says a word other than a
// reserved word, an assignment or `builtin` was skipped: the command may run outside the shell, where a cd moves
// nothing (zsh's `command cd` runs /usr/bin/cd in a child, measured with zsh 5.9 on macOS; bash's runs the builtin).
const commandOf = (words: string[]): { words: string[]; chdir: string | undefined; outside: boolean } => {
  let i = 0
  let chdir: string | undefined
  let outside = false
  const at = (k = 0): string => nameOf(words[i + k])
  for (;;) {
    const w = at()
    if (RESERVED.has(w) || ASSIGNMENT.test(words[i] ?? '') || w === 'builtin') i++
    else if (w === 'nohup') i++
    else if (w === 'time') i += at(1) === '-p' ? 2 : 1
    else if (w === 'command' && !/^-[vV]/.test(at(1))) i += at(1) === '-p' ? 2 : 1
    else if (w === 'exec') {
      i++
      while (/^-[cl]+$/.test(at())) i++
      if (at() === '-a') i += 2
    } else if (w === 'nice') i += at(1) === '-n' ? 3 : /^-n?\d+$/.test(at(1)) ? 2 : 1
    else if (w === 'timeout') {
      i++
      while (at().startsWith('-')) i += /^-[sk]$/.test(at()) ? 2 : 1
      i++
    } else if (w === 'env') {
      const env = i++
      for (;;) {
        const o = words[i] ?? ''
        if (o === '-C' || o === '--chdir') [chdir, i] = [words[i + 1] ?? '', i + 2]
        else if (o.startsWith('--chdir=')) [chdir, i] = [o.slice(8), i + 1]
        else if (/^-C./.test(o)) [chdir, i] = [o.slice(2), i + 1]
        else if (/^(-S|--split-string)/.test(o)) return { words: words.slice(env), chdir, outside: true }
        else if (o === '-u' || o === '--unset') i += 2
        else if (o === '--') {
          i++
          break
        } else if (o.startsWith('-') || ASSIGNMENT.test(o)) i++
        else break
      }
    } else break
    outside ||= !(RESERVED.has(w) || ASSIGNMENT.test(w) || w === 'builtin')
  }

  return { words: words.slice(i), chdir, outside }
}

// Commands that carry text without running it: a message, a body, a search pattern, an echo. A phrase inside one
// of these is a mention. The list is closed on purpose: any other command that carries the phrase may run it.
const TEXT_CARRIERS = new Set(['echo', 'printf', 'cat', 'grep', 'egrep', 'fgrep', 'rg', 'gh'])
const TEXT_GIT = new Set(['commit', 'tag', 'notes', 'log', 'grep', 'show'])
// Commands that run no text of the command (a file a carrier wrote, its output through a pipe or a substitution):
// with only these and the carriers in a command, a mention stays text. Closed too: any other command (a shell,
// eval, source, xargs, an interpreter, a script, make, npm) may run what a carrier wrote or printed.
const QUIET = new Set([...TEXT_CARRIERS, 'cd', 'pushd', 'popd', 'chdir', 'true', 'false', ':', 'test', '[', 'ls', 'pwd',
  'mkdir', 'touch', 'wc', 'head', 'tail', 'sort', 'uniq', 'diff', 'cut', 'tr', 'basename', 'dirname', 'date'])
const QUIET_GIT = new Set([...TEXT_GIT, 'add', 'status', 'diff', 'push', 'fetch', 'pull', 'branch', 'checkout', 'switch',
  'restore', 'rm', 'mv', 'stash', 'rev-parse', 'merge-base', 'remote', 'reset', 'ls-files', 'worktree'])

// The builtins that move a shell's directory (bash(1) SHELL BUILTIN COMMANDS: cd, pushd, popd; chdir in
// some shells).
const DIR_CHANGE = /^(cd|pushd|popd|chdir)$/

const PHRASE = /\bworktree\s+add\b/
// A word the shell turns into other words before git reads it: a parameter, a substitution, a glob or a brace
// (bash(1) EXPANSION). In git's subcommand or verb place it may spell `worktree` or `add` (`git $W add`).
const EXPANDS = /[$`*?[{]/

// One `git worktree add` a shell runs: the path it names (undefined: none), the step it is (`at`), and whether the
// directory git runs in is set by `git -C` or `env -C`.
export type Add = { path: string | undefined; at: number; gitC: boolean; envC: boolean }

// The one reading of a command that the refusal and the registration both use. `adds` are the adds a shell runs, at
// any depth of substitution; `mentions` the paths named by text no shell runs (a message, a body, an echo); `doubt`,
// when set, is why an add may run where the command does not say (the call is refused then).
export type Adds = { steps: Step[]; adds: Add[]; mentions: string[]; doubt: string | undefined }

// The paths a mention names after `git ... worktree add`, every one of them: in the words of the step (`echo git
// worktree add p`), or inside one word or the body, read as prose (a message: `-m "git worktree add p"`). A quoted
// phrase is one word, so the word after it is not its path (`grep 'git worktree add' docs` names none).
const mentionedPaths = (step: Step): string[] => {
  const paths: string[] = []
  const scan = (t: string[]): void =>
    t.forEach((word, i) => {
      if (word !== 'git') return
      const sub = gitSubcommandIndex(t, i)
      const path = t[sub] === 'worktree' && t[sub + 1] === 'add' ? pathAfterAdd(t, sub) : undefined
      if (path !== undefined) paths.push(path)
    })
  scan(step.words)
  for (const text of [...step.words, step.body]) if (PHRASE.test(text)) scan(tokensOf(text))
  return paths
}

export const worktreeAdds = (command: string): Adds => {
  const { steps, open } = shellSteps(command)
  const adds: Add[] = []
  const mentions: string[] = []
  let doubt: string | undefined
  let mentioned = false
  let runner: string | undefined
  steps.forEach((step, at) => {
    const run = commandOf(step.words)
    const head = nameOf(run.words[0])
    const sub = head === 'git' ? gitSubcommandIndex(run.words, 0) : -1
    const verb = nameOf(run.words[sub])
    if (verb === 'worktree' && nameOf(run.words[sub + 1]) === 'add') {
      adds.push({ path: pathAfterAdd(run.words, sub), at, gitC: run.words.slice(1, sub).includes('-C'), envC: run.chdir !== undefined })
      return
    }
    // A command name the shell expands may be git; git's subcommand or its worktree verb expanded may be an add.
    if (head === 'git' || /[$`]/.test(head)) {
      const named = gitSubcommandIndex(run.words, 0)
      const [first, second] = [run.words[named] ?? '', run.words[named + 1] ?? '']
      if (EXPANDS.test(first) || (nameOf(first) === 'worktree' && EXPANDS.test(second)))
        doubt ??= `git's subcommand is spelled by the shell (${[run.words[0], first, second].join(' ')}), so it may be a worktree add`
    }
    const global = run.words.slice(1, Math.max(sub, 1))
    const quiet = head === '' || QUIET.has(head) || (head === 'git' && QUIET_GIT.has(verb) && !global.includes('-c') && !global.includes('--config-env'))
    if (!quiet) runner ??= head
    const text = [...step.words, step.body].join(' ')
    if (!PHRASE.test(text)) return
    if (!TEXT_CARRIERS.has(head) && !(head === 'git' && TEXT_GIT.has(verb))) {
      doubt ??= `the words of ${head || 'a variable assignment'} name a git worktree add, which it may run`
      return
    }
    if (step.expands && /\$\(|`/.test(step.body)) doubt ??= 'an unquoted here-document runs the $( ) and backticks in its body'
    mentioned = true
    mentions.push(...mentionedPaths(step))
  })
  if (open && /worktree/.test(command)) doubt ??= 'a quote or a substitution in the command is not closed'
  if (mentioned && runner !== undefined) doubt ??= `text that names a git worktree add reaches ${runner}, which may run it`

  return { steps, adds, mentions, doubt }
}

// The path of the first add a shell runs, if any.
export const worktreeAddPath = (command: string): string | undefined => {
  return worktreeAdds(command).adds[0]?.path
}

// `base` and `rel` joined, `.` segments dropped; `..` is left for the file system to fold (a link before it
// lands elsewhere than a lexical fold says).
const joinPath = (base: string, rel: string): string =>
  `${base.replace(/[\\/]+$/, '')}/${rel}`.split('/').filter((segment) => segment !== '.').join('/')

// `path` is where the worktree lands; `reason` is why that is not known.
export type AddPlace = { path: string } | { reason: string }

// Where one add's worktree lands, from the command's steps and the directory the shell starts in (`cwd`, the
// session's; undefined when it could not be read; `agentId` is set inside a subagent's loop). A relative path is
// the shell's when git runs: the start directory, or the one a leading `cd <dir>` took it to when every command
// from that cd to git is joined by `&&` (git runs only once each succeeded, and none of them is itself a directory
// change); the cd may be spelled `builtin cd` or after an assignment. Any other directory change before git (also
// one through `command`, `exec` or `env`, which zsh runs outside the shell), a `git -C` or an `env -C`, an add inside
// a substitution, a `~` or a variable, or a path with a space leaves it unknown, and the answer is the reason, never
// a guess.
const placeAdd = (steps: Step[], add: Add, cwd: string | undefined, agentId: string | undefined): AddPlace => {
  const unknown = (why: string): AddPlace => ({ reason: `the path ${add.path ?? ''} could not be resolved: ${why}` })
  const { path } = add
  if (path === undefined) return unknown('the add names no path')
  if (/\s/.test(path)) return unknown('the path has a space in it')
  if (/^~|[$`]/.test(path)) return unknown('the shell expands it')
  if (isAbsolute(path)) return { path }
  if (steps[add.at]?.owner !== undefined) return unknown('it runs inside a command substitution')
  if (add.gitC) return unknown('git -C changes the directory it is relative to')
  if (add.envC) return unknown('env -C changes the directory git runs in')
  const before = steps.slice(0, add.at)
  const moved = before.filter((s) => DIR_CHANGE.test(nameOf(commandOf(s.words).words[0])))
  let start = cwd
  let fromCwd = true
  const lead = before[0]
  if (moved.length > 0) {
    // The commands of a substitution run inside the step that holds it, not between the cd and git.
    const chained = steps.slice(1, add.at + 1).every((s) => s.owner !== undefined || s.sep === '&&')
    const run = commandOf(lead?.words ?? [])
    const cd = run.words
    if (moved.length !== 1 || lead?.sep !== '' || !chained || cd.length !== 2 || nameOf(cd[0]) !== 'cd')
      return unknown(`the shell's directory is changed before git runs (${nameOf(commandOf((moved[0] as Step).words).words[0])})`)
    if (run.outside) return unknown(`the cd may run outside the shell (${lead.words.join(' ')}), so whether it moved the shell depends on the shell`)
    const dir = cd[1] ?? ''
    if (dir === '' || /^[~-]|[$`\s*?[{]/.test(dir)) return unknown(`the shell's directory is changed to ${dir || 'its home'} before git runs`)
    if (isAbsolute(dir)) {
      start = dir
      fromCwd = false
    } else start = cwd === undefined ? undefined : joinPath(cwd, dir)
  }
  if (fromCwd && agentId !== undefined) return unknown("a subagent's shell may start in another directory than the session's")
  if (start === undefined) return unknown("the session's directory could not be read")

  return { path: joinPath(start, path) }
}

// Where each add a shell runs lands, in the order of `adds.adds`.
export const placeWorktreeAdds = (adds: Adds, cwd: string | undefined, agentId?: string): AddPlace[] =>
  adds.adds.map((add) => placeAdd(adds.steps, add, cwd, agentId))

const refuseWorktree = (what: string): Verdict => ({
  allow: false,
  rule: WORKTREE_RULE,
  reason: `${what}: a worktree lives at <repo>/.claude/worktrees/<name>/ (.Codex/worktrees/ for Codex), never outside the repo.`,
})

// Every add a shell runs and every path a mention names is judged (a file a mention wrote may be run by a later
// call); an add that may run where the command does not say is refused, in doubt.
export const judgeShellWorktree = (command: string): Verdict => {
  const { adds, mentions, doubt } = worktreeAdds(command)
  if (doubt !== undefined)
    return refuseWorktree(`a git worktree add whose path cannot be read from the command (${doubt}); run the add as a command of its own`)
  for (const path of [...adds.map((add) => add.path), ...mentions])
    if (path !== undefined && !landsInWorktreeRoot(path)) return refuseWorktree(`git worktree add ${path}`)
  return ALLOW
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
