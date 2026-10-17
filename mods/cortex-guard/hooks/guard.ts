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

// source: bash(1) QUOTING, ANSI-C quoting: in `$'...'` these backslash escapes are decoded (zsh(1) does the same).
const ANSI_ESCAPES: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' }
const ANSI_NUMERIC = /^(?:x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|([0-7]{1,3}))/

// The text of a `$'...'` word part that opens at `from` (just after the quote), decoded, and the index of its
// closing quote (`s.length` when it never closes).
const ansiC = (s: string, from: number): { text: string; end: number } => {
  let text = ''
  let j = from
  while (j < s.length && s[j] !== "'") {
    if (s[j] !== '\\' || j + 1 >= s.length) {
      text += s[j++]
      continue
    }
    const m = ANSI_NUMERIC.exec(s.slice(j + 1))
    if (m !== null) {
      const [hex, u4, u8, oct] = [m[1], m[2], m[3], m[4]]
      const code = hex ?? u4 ?? u8 ? parseInt(hex ?? u4 ?? u8 ?? '', 16) : parseInt(oct ?? '', 8)
      text += code <= 0x10ffff ? String.fromCodePoint(code) : ''
      j += 1 + m[0].length
    } else if (s[j + 1] === 'c' && j + 2 < s.length) {
      text += String.fromCharCode(s.charCodeAt(j + 2) & 31)
      j += 3
    } else {
      const e = s[j + 1] ?? ''
      text += ANSI_ESCAPES[e] ?? `\\${e}`
      j += 2
    }
  }
  return { text, end: j }
}

// The command's simple commands, split at the shell's separators outside quotes (bash(1) SHELL GRAMMAR), not on
// whitespace: `true;git` is two commands. `$(`, a backtick and `<(`/`>(` open a substitution, outside quotes and
// inside double quotes alike, whose commands are steps of their own. A here-document's body is attached to the
// command that opened it, wherever that command is on its line. A comment is dropped. `$'...'` is decoded. A
// backslash outside quotes makes the next character literal, whatever it is (`.\.` is `..`, `C:\x` is `C:x`), and joins
// lines before a newline; inside double quotes it escapes `$` `` ` `` `"` `\` and a newline only. `open` says a quote or
// a substitution never closed: nothing read after it is sure.
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
  // A `$'...'` that never closed.
  let unclosed = false
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
    } else if (c === '$' && next === "'") {
      const { text, end } = ansiC(command, i + 2)
      word = (word ?? '') + text
      if (end >= n) unclosed = true
      i = end
    } else if (c === '\\' && next === '\n') i++
    // source: bash(1) QUOTING: "A non-quoted backslash (\) is the escape character. It preserves the literal value of
    // the next character that follows" (zsh(1) QUOTING says the same). Measured with `printf '%s\n'` under bash 5.3.15
    // and zsh 5.9: `a/.\./x` is `a/../x`, `a\bc` is `abc`, `C:\Users\x` is `C:Usersx`, `\\host` is `\host`
    // (docs/verification/pr30-probes-round5/bs.out). A backslash that ends the text stays.
    else if (c === '\\' && next !== '') word = (word ?? '') + command[++i]
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

  return { steps, open: unclosed || quote !== undefined || frames.some((frame) => frame.kind !== '(') }
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

// source: git-config(1) VARIABLES. The keys `git -c` may set without git running a program (a pager, an editor, an
// alias, a hook path, a helper, and signing, which runs gpg.program, do run one); config keys are case-insensitive.
// Closed on purpose.
const QUIET_CONFIG = /^((user|author|committer)\.(name|email)|core\.quotepath|init\.defaultbranch|(color|advice)\.[a-z.]+)$/i
// A word that is one expansion and nothing else (`$W`, `${W}`, `$1`, `$(cmd)`): it may become any one word, such as
// a subcommand.
const BARE = /^(\$([A-Za-z_]\w*|\{[^}]*\}|[@*#?$!\d])|\$\(.*\)|`.*`)$/s
// source: git-config(1) ENVIRONMENT: GIT_CONFIG_COUNT/GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> and
// GIT_CONFIG_PARAMETERS set config for one run, where a key alias.<name> defines a git subcommand.
const CONFIG_ENV = /^GIT_CONFIG_(VALUE_\d+|PARAMETERS)=(.*)$/is

// Whether an alias's value may be worktree: it names it, or the shell spells it (`alias.wt=$W`). An alias to
// another command (`alias.co=checkout`) is not a doubt.
const mayBeWorktree = (value: string): boolean => /worktree/i.test(value.replace(/['"\\]/g, '')) || EXPANDS.test(value)

// The alias `git config` sets in its arguments (after the subcommand) whose value may be worktree: the word after an
// `alias.<name>` key is its value; the other words (`--file=$CFG`, `--global`) are not.
const configAlias = (args: string[]): string | undefined => {
  for (const [k, key] of args.entries()) {
    const value = args[k + 1]
    if (/^alias\./i.test(key) && value !== undefined && mayBeWorktree(value)) return `${key} ${value}`
  }
  return undefined
}

// The key of a `<key>=<value>` setting.
const keyOf = (setting: string): string => setting.split('=')[0] ?? ''

// The `<key>=<value>` settings git's global options (the words between `git` and its subcommand) make. For
// --config-env the value is held by a variable, so it is given as `$<variable>`: spelled by the shell.
const configSettings = (global: string[]): string[] =>
  global.flatMap((option, i) => {
    const prev = global[i - 1]
    const fromEnv = prev === '--config-env' ? option : option.startsWith('--config-env=') ? option.slice('--config-env='.length) : undefined
    if (fromEnv !== undefined) return [`${keyOf(fromEnv)}=$${fromEnv.slice(keyOf(fromEnv).length + 1)}`]
    const setting = prev === '-c' ? option : option.startsWith('-c') && option.length > 2 ? option.slice(2) : undefined
    return setting === undefined ? [] : [setting]
  })

// The word pair that reads like a worktree add in `words`: `worktree add`, or git's `worktree` verb before a word
// the shell expands (`git worktree "$1"`; prose such as `worktree $P` is not git's verb); with `named`, also an
// expanded word after the command's name and before `add` (`$G $W add`), or two bare expansions in git's subcommand
// and verb places (`$G $W $A`); `named` says the command's name (the first word) is spelled by the shell and may be
// git. `worktree` and `add` are read as a command name is (`\add`); an expansion is tested on the word as the split
// left it (an escaped `\$` outside quotes is left as `$`, and counts as one: in doubt).
const addPair = (words: string[], named = false): string | undefined => {
  const verbs = new Set(words.flatMap((word, j) => (nameOf(word) === 'git' || (named && j === 0) ? [gitSubcommandIndex(words, j)] : [])))
  for (let i = 0; i + 1 < words.length; i++) {
    const [a, b] = [words[i] ?? '', words[i + 1] ?? '']
    const add = nameOf(b) === 'add'
    if ((nameOf(a) === 'worktree' && (add || (verbs.has(i) && EXPANDS.test(b)))) || (named && i > 0 && add && EXPANDS.test(a))) return `${a} ${b}`
    if (named && verbs.has(i) && BARE.test(a) && BARE.test(b)) return `${a} ${b}`
  }
  return undefined
}

// The variables the steps assign a value that word-splits into several words, one of them `worktree`
// (`GW='git worktree'`): used as a command name they spell git's verb. A value of one word (`W=worktree`) is read
// where the variable is used (`$G $W add`); `WA='worktree add'` is read as the value it is (textParts).
const splitVars = (steps: Step[]): Set<string> =>
  new Set(
    steps.flatMap((step) => step.words).flatMap((word) => {
      const m = /^([A-Za-z_]\w*)=(.*)$/s.exec(word)
      const values = (m?.[2] ?? '').trim().split(/\s+/)
      return m !== null && values.length > 1 && values.some((value) => nameOf(value) === 'worktree') ? [m[1] ?? ''] : []
    }),
  )

// Why one step's own command may run a worktree add its words do not spell, or undefined: git's subcommand or
// worktree verb spelled by the shell, a git alias the command defines whose value may be worktree (`git -c
// alias.wt=worktree`, `git config alias.wt worktree`, GIT_CONFIG_VALUE_<n>=worktree), or a command name the shell
// spells whose words read like an add. The same check for a step of the command and for a step of text a shell runs
// (`sh -c '...'`). An alias already in a config file is not in the command, and is not seen. `splits` are the
// variables the command assigns several words (splitVars).
const commandDoubt = (step: Step, splits: Set<string>): string | undefined => {
  const run = commandOf(step.words)
  const head = nameOf(run.words[0])
  const env = step.words.find((word) => {
    const m = CONFIG_ENV.exec(word)
    return m !== null && mayBeWorktree(m[2] ?? '') && (/^value/i.test(m[1] ?? '') || /alias\./i.test(m[2] ?? ''))
  })
  if (env !== undefined) return `the command sets git config that may define a worktree alias (${env})`
  if (head === 'git') {
    const sub = gitSubcommandIndex(run.words, 0)
    const [first, second] = [run.words[sub] ?? '', run.words[sub + 1] ?? '']
    if (EXPANDS.test(first) || (nameOf(first) === 'worktree' && EXPANDS.test(second)))
      return `git's subcommand is spelled by the shell (${['git', first, second].join(' ').trim()}), so it may be worktree add`
    const rest = run.words.slice(sub + 1)
    const alias = configSettings(run.words.slice(1, sub)).find((s) => /^alias\./i.test(keyOf(s)) && mayBeWorktree(s.slice(keyOf(s).length + 1)))
      ?? (nameOf(first) === 'config' ? configAlias(rest) : undefined)
    if (alias !== undefined) return `the command defines a git alias that may be worktree (${alias})`
  } else if (/[$`]/.test(head)) {
    const used = /^\$\{?(\w+)\}?$/.exec(head)?.[1] ?? ''
    const next = run.words[1] ?? ''
    if (splits.has(used) && (nameOf(next) === 'add' || EXPANDS.test(next)))
      return `the command's name ${run.words[0] ?? ''} is set in the command to words that include worktree, so it may be git worktree ${next}`
    const pair = addPair(run.words, true)
    if (pair !== undefined) return `the command's name is spelled by the shell (${run.words[0] ?? ''}) and its words read like a worktree add (${pair}), so it may be git`
  }
  return undefined
}

// How deep text inside text is read (`sh -c "bash -c '...'"` is two); deeper, the quote-free text is matched.
const DEPTH = 4

// source: bash(1) INVOCATION, sh(1), zsh(1): a shell reads a command string (`-c`), its standard input or a file.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'csh', 'tcsh'])
// The name of the program a word runs, without its directory (`/bin/sh` is sh).
const baseOf = (word: string | undefined): string => nameOf(word).replace(/^.*\//, '')

// Whether a step runs the text of its words as shell commands: its command is a shell or `eval` (bash(1) SHELL
// BUILTIN COMMANDS: eval joins its arguments and reads them), or a program that is not a quiet one is given a shell
// or eval (`sudo bash -c`, `xargs sh -c`). Closed and over-inclusive: all the words of such a step are commands.
const runsText = (words: string[]): boolean => {
  const run = commandOf(words).words
  const head = baseOf(run[0])
  if (SHELLS.has(head) || head === 'eval') return true
  return !QUIET.has(head) && run.slice(1).some((word) => SHELLS.has(baseOf(word)) || baseOf(word) === 'eval')
}

// Whether a step may read text another step carries: it runs text, or it is `source` / `.` (bash(1) SHELL BUILTIN
// COMMANDS), which runs a file a carrier wrote. A carrier's text (an echo, a message) is run as commands only when
// a step like this is in the command. `ssh h "$X $Y $Z"` is not one: the remote host runs its text, in no
// repository of this machine (a phrase that spells a worktree add outright is still refused there).
const readsText = (words: string[]): boolean => runsText(words) || /^(source|\.)$/.test(nameOf(commandOf(words).words[0]))

// The pair that reads like a worktree add in `text` read as a shell reads it: split into steps, quotes resolved,
// and every word or here-document body that is itself shell text read the same way (a string `sh -c` runs, a
// message `eval` runs). `wor''ktree "add"` is `worktree add`. Text whose quotes do not close, or nested past DEPTH,
// is matched with PHRASE once its quotes and backslashes are taken out: a floor, used only where the split is not
// sure. `full` says the text is run, or may be (the command has a step that reads text): its steps are read as
// commands then, with commandDoubt. Otherwise no shell runs it (a message, an argument of `rm`, `curl`, `ssh`), and
// only a phrase that spells `worktree add` is an add in it.
const addIn = (text: string, depth: number, full: boolean, outer: Set<string>): string | undefined => {
  const plain = text.replace(/\\\n|['"\\]/g, '')
  // Nothing in it can read like an add: commandDoubt and addPair need `worktree`, `add`, `git`, an alias or
  // GIT_CONFIG, or two expansions in a row (`$G $W $A`).
  if (!/worktree|\badd\b|\bgit\b|alias|GIT_CONFIG/i.test(plain) && !/[$`]\S*\s+[$`]/.test(text)) return undefined
  if (depth > DEPTH) return PHRASE.exec(plain)?.[0]
  const { steps, open } = shellSteps(text)
  const scope: Scope = { consumer: full && steps.some((step) => readsText(step.words)), splits: new Set([...outer, ...splitVars(steps)]) }
  for (const step of steps) {
    const found = stepAdd(step, depth, full, scope)
    if (found !== undefined) return found
  }
  return open ? PHRASE.exec(plain)?.[0] : undefined
}

// What a list of steps tells about each step in it: `consumer`, a step reads text another carries; `splits`, the
// variables assigned several words (splitVars), those of the text around it included.
type Scope = { consumer: boolean; splits: Set<string> }

// A word or body that may hold more than one word of shell text.
const SHELL_TEXT = /[\s'"\\]/

// The parts of a step that may be shell text: its words, the value of a word `name=value` apart from its name
// (`WA="worktree add"` is the word `WA=worktree add`, which splits into `WA=worktree` and `add`), the
// here-document body, and, for `eval`, its arguments joined by blanks, as eval reads them.
const textParts = (step: Step): string[] => {
  const run = commandOf(step.words).words
  const joined = baseOf(run[0]) === 'eval' ? [run.slice(1).join(' ')] : []
  const values = step.words.map((word) => word.replace(/^[^\s=]+=/, '')).filter((value, k) => value !== step.words[k])

  return [...step.words, ...values, ...joined, step.body]
}

// What reads like a worktree add in one step: its own command (commandDoubt, when `full`), its words, or the
// shell text inside one of them or inside its here-document body, read the same way. The first found is returned.
// The text inside a step is read as commands when the step runs text (a shell, eval) or the command has a reader
// of text (`consumer`: `echo '$G $W $A p' | sh`); otherwise as text only.
const stepAdd = (step: Step, depth: number, full: boolean, scope: Scope): string | undefined => {
  const own = (full ? commandDoubt(step, scope.splits) : undefined) ?? addPair(step.words)
  if (own !== undefined) return own
  const runs = runsText(step.words) || scope.consumer
  for (const part of textParts(step)) {
    const found = SHELL_TEXT.test(part) ? addIn(part, depth + 1, runs, scope.splits) : undefined
    if (found !== undefined) return found
  }
  return undefined
}

// The text with its quotes, backslashes and line continuations taken out, split at whitespace: the floor's words.
const plainWords = (text: string): string[] => text.replace(/\\\n|['"\\]/g, '').split(/\s+/)

// Every word list of a step read as a shell reads it: its words, and those of the shell text inside them. Text
// whose quotes do not close, or nested past DEPTH, also gives its plain words (the floor addIn matches too), so a
// path the floor sees is judged.
const wordLists = (step: Step, depth = 0): string[][] => [
  step.words,
  ...[...step.words, step.body].filter((part) => SHELL_TEXT.test(part)).flatMap((part) => {
    if (depth >= DEPTH) return [plainWords(part)]
    const { steps, open } = shellSteps(part)
    return [...steps.flatMap((inner) => wordLists(inner, depth + 1)), ...(open ? [plainWords(part)] : [])]
  }),
]

// One `git worktree add` a shell runs: the path it names (undefined: none), the step it is (`at`), and whether the
// directory git runs in is set by `git -C` or `env -C`.
export type Add = { path: string | undefined; at: number; gitC: boolean; envC: boolean }

// The one reading of a command that the refusal and the registration both use. `adds` are the adds a shell runs, at
// any depth of substitution; `mentions` the paths named by text no shell runs (a message, a body, an echo); `doubt`,
// when set, is why an add may run where the command does not say (the call is refused then).
export type Adds = { steps: Step[]; adds: Add[]; mentions: string[]; doubt: string | undefined }

// The paths a mention names after `git ... worktree add`, every one of them: in the words of the step (`echo git
// worktree add p`), or inside one word or the body, split as a shell splits it (a message: `-m "git worktree add
// p"`). A quoted phrase is one word, so the word after it is not its path (`grep 'git worktree add' docs` names none).
const mentionedPaths = (step: Step): string[] =>
  wordLists(step).flatMap((t) =>
    t.flatMap((word, i) => {
      if (nameOf(word) !== 'git') return []
      const sub = gitSubcommandIndex(t, i)
      const path = nameOf(t[sub]) === 'worktree' && nameOf(t[sub + 1]) === 'add' ? pathAfterAdd(t, sub) : undefined
      return path === undefined ? [] : [path]
    }))

export const worktreeAdds = (command: string): Adds => {
  const { steps, open } = shellSteps(command)
  const adds: Add[] = []
  const mentions: string[] = []
  let doubt: string | undefined
  let mentioned = false
  let runner: string | undefined
  const scope: Scope = { consumer: steps.some((step) => readsText(step.words)), splits: splitVars(steps) }
  steps.forEach((step, at) => {
    const run = commandOf(step.words)
    const head = nameOf(run.words[0])
    const sub = head === 'git' ? gitSubcommandIndex(run.words, 0) : -1
    const verb = nameOf(run.words[sub])
    if (verb === 'worktree' && nameOf(run.words[sub + 1]) === 'add') {
      adds.push({ path: pathAfterAdd(run.words, sub), at, gitC: run.words.slice(1, sub).includes('-C'), envC: run.chdir !== undefined })
      return
    }
    // A command that may be an add its words do not spell (`git $W add`, `git -c alias.wt=worktree wt add`,
    // `$G $W add`); a variable command whose words do not read like an add is not (`"$PY" "$S"`).
    const own = commandDoubt(step, scope.splits)
    if (own !== undefined) {
      doubt ??= own
      return
    }
    const keys = head === 'git' ? configSettings(run.words.slice(1, sub)).map(keyOf) : []
    const quiet = head === '' || QUIET.has(head) || (head === 'git' && QUIET_GIT.has(verb) && keys.every((key) => QUIET_CONFIG.test(key)))
    if (!quiet) runner ??= head
    const pair = stepAdd(step, 0, false, scope)
    if (pair === undefined) return
    if (!TEXT_CARRIERS.has(head) && !(head === 'git' && TEXT_GIT.has(verb))) {
      doubt ??= `the words of ${head || 'a variable assignment'} read like a worktree add (${pair}), which it may run`
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
    return refuseWorktree(`the command may run a git worktree add whose path cannot be read from it (${doubt}); spell the add out, as a command of its own`)
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
