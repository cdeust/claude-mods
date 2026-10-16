// The commands a Bash command line runs, read in one pass the way the shell reads them: quotes, `$(...)`,
// backticks, backslash continuations and heredocs span lines, so a line is no unit of a command.
// source: the POSIX Shell Command Language (XCU 2.2 Quoting, 2.3 Token Recognition, 2.6.3 Command
// Substitution, 2.7.4 Here-Document, 2.9 Shell Commands) and bash's manual for `<<<`, `&>`, `|&` and `$'...'`.
//
// Invariant of the scan, held at every step: `i` is the first character not yet read; every character before
// it belongs to exactly one of a word of the current command, an operator, a comment, a continuation, or the
// body of a heredoc whose operator was read on an earlier line. Hence a quoted, substituted or heredoc
// character never ends a command, and a separator ends one only where the shell reads it as one.

// One simple command: its words with each quoted span and substitution as `''` (a head, an option and a
// separator are read on it only where the shell reads them), the source text it came from (inline code
// is read there), and the files it redirects output into, spelled as the shell would open them.
export type ShellCommand = { bare: string; raw: string; targets: string[] }

type Word = { literal: string; bare: string; quoted: boolean }
type Doc = { end: string; dash: boolean; expands: boolean }

const BLANK = /[ \t]/ // source: XCU 2.3, a <blank> delimits a token
// The characters that end an unquoted word (XCU 2.2: the metacharacters, and the newline).
const META = /[ \t\n;&|()<>]/
// At the start of a token: an operator that redirects (`2>&1`, `&>`, `>|`, `<<-`, `<<<`), or one that ends a command.
const REDIRECT_OP = /^(?:[0-9]+)?(?:>>|>\||>&|>|<<<|<<-|<<|<&|<>|<)|^&>>?/
const SEPARATOR_OP = /^(?:&&|\|\||\|&|;;|;|\||&)/
// A duplicated descriptor (`>&2`, `>&-`) opens no file.
const DESCRIPTOR = /^([0-9]+|-)$/

export const shellCommands = (src: string): ShellCommand[] => {
  const out: ShellCommand[] = []
  let i = 0
  // Heredocs whose operator was read on the current line: their bodies start at its newline, in order.
  let pending: Doc[] = []

  // A heredoc body is whole lines up to its terminator (leading tabs stripped for `<<-`). An unquoted
  // delimiter's body is expanded by the shell, so its substitutions run; a quoted one's is data.
  const bodies = (): void => {
    const docs = pending
    pending = []
    for (const d of docs) {
      while (i < src.length) {
        const nl = src.indexOf('\n', i)
        const stop = nl === -1 ? src.length : nl
        const line = src.slice(i, stop)
        if ((d.dash ? line.replace(/^\t+/, '') : line) === d.end) {
          i = nl === -1 ? src.length : nl + 1
          break
        }
        if (d.expands) expanding(stop)
        i = nl === -1 ? src.length : nl + 1
      }
    }
  }

  // Text where only `\`, `$(` and backticks are special (inside double quotes, or an expanding heredoc body),
  // up to `stop` or the closing `"` when `quote` is set.
  const expanding = (stop: number, quote = false): string => {
    let literal = ''
    while (i < stop) {
      const c = src[i] ?? ''
      if (quote && c === '"') {
        i += 1
        return literal
      }
      if (c === '\\') {
        const n = src[i + 1] ?? ''
        i += 2
        if (n !== '\n') literal += '$`"\\'.includes(n) ? n : `\\${n}`
        continue
      }
      if (c === '$' && src[i + 1] === '(') {
        substitution()
        literal += '$()'
        continue
      }
      if (c === '`') {
        i += 1
        list('`')
        literal += '$()'
        continue
      }
      literal += c
      i += 1
    }
    return literal
  }

  // `$(...)` runs its commands; `$((...))` is arithmetic, a value.
  const substitution = (): void => {
    if (src[i + 2] === '(') {
      let depth = 0
      while (i < src.length) {
        const c = src[i]
        i += 1
        if (c === '(') depth += 1
        else if (c === ')' && --depth === 0) return
      }
      return
    }
    i += 2
    list(')')
  }

  // One word: unquoted text, quoted spans and substitutions, up to a blank or a metacharacter.
  const word = (close: string): Word => {
    let literal = ''
    let bare = ''
    let quoted = false
    while (i < src.length) {
      const c = src[i] ?? ''
      if (META.test(c) || c === close) break
      if (c === "'") {
        const end = src.indexOf("'", i + 1)
        const stop = end === -1 ? src.length : end
        literal += src.slice(i + 1, stop)
        i = stop + 1
        bare += "''"
        quoted = true
      } else if (c === '"') {
        i += 1
        literal += expanding(src.length, true)
        bare += "''"
        quoted = true
      } else if (c === '$' && src[i + 1] === "'") {
        i += 2
        while (i < src.length && src[i] !== "'") i += src[i] === '\\' ? 2 : 1
        i += 1
        bare += "''"
        quoted = true
      } else if (c === '$' && src[i + 1] === '(') {
        substitution()
        literal += '$()'
        bare += "''"
      } else if (c === '`') {
        i += 1
        list('`')
        literal += '$()'
        bare += "''"
      } else if (c === '$' && src[i + 1] === '{') {
        const end = src.indexOf('}', i)
        const stop = end === -1 ? src.length : end + 1
        literal += src.slice(i, stop)
        bare += src.slice(i, stop)
        i = stop
      } else if (c === '\\') {
        const n = src[i + 1] ?? ''
        i += 2
        if (n === '\n') continue
        literal += n
        bare += /[\w./:=+,@%-]/.test(n) ? n : '_'
        quoted = true
      } else {
        literal += c
        bare += c
        i += 1
      }
    }
    return { literal, bare, quoted }
  }

  const blanks = (): void => {
    while (i < src.length) {
      if (BLANK.test(src[i] ?? '')) i += 1
      else if (src[i] === '\\' && src[i + 1] === '\n') i += 2
      else return
    }
  }

  // The commands up to `close` (`)` of `$(`, a backtick, or '' for the end of the text); `i` is left past it.
  const list = (close: string): void => {
    let words: string[] = []
    let targets: string[] = []
    let start = i
    let depth = 0 // subshells opened inside this list: their `)` ends a command, not the list
    const finish = (): void => {
      if (words.length > 0 || targets.length > 0) out.push({ bare: words.join(' '), raw: src.slice(start, i).trim(), targets })
      words = []
      targets = []
    }
    while (true) {
      blanks()
      if (words.length === 0 && targets.length === 0) start = i
      if (i >= src.length) break
      const c = src[i] ?? ''
      const rest = src.slice(i, i + 4)
      if (c === close && !(close === ')' && depth > 0)) {
        finish()
        i += 1
        return
      }
      if (c === '\n') {
        finish()
        i += 1
        bodies()
        continue
      }
      if (c === '#') {
        while (i < src.length && src[i] !== '\n') i += 1
        continue
      }
      if (c === '(' || c === ')') {
        finish()
        depth = Math.max(0, depth + (c === '(' ? 1 : -1))
        i += 1
        continue
      }
      const redirect = REDIRECT_OP.exec(rest)?.[0]
      if (redirect !== undefined) {
        i += redirect.length
        blanks()
        const op = redirect.replace(/^[0-9]+/, '')
        const target = word(close)
        if (op === '<<' || op === '<<-') pending.push({ end: target.literal, dash: op === '<<-', expands: !target.quoted })
        else if (op.startsWith('<') && op !== '<>') continue
        else if (op.endsWith('&') && DESCRIPTOR.test(target.literal)) continue
        else targets.push(target.literal)
        continue
      }
      const separator = SEPARATOR_OP.exec(rest)?.[0]
      if (separator !== undefined) {
        finish()
        i += separator.length
        continue
      }
      const before = i
      const w = word(close)
      if (i === before) i += 1 // a character no rule above reads: skipped, so the scan always moves on
      else words.push(w.bare)
    }
    finish()
  }

  list('')
  return out
}
