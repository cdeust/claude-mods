// The shape of a Bash command line: its simple commands in order, the operator that follows each, the
// regexes that name a version-control or pull-request verb, and which segment the call's single exit
// status can be attributed to. Pure and total. The events built on it are in events.ts; what each
// cannot tell is written in docs/insights-outcome-model.md.

const MAX_SEGMENT = 4000 // source: own choice, characters of a command classified; a longer one is a script written inline, and its first lines name its runner

// `after` is the operator that follows the segment ('&&', '||', ';', '\n', '&', '|'), '' for the last.
// `piped` marks a segment whose output goes into a pipe (its exit status is then not the command's,
// unless pipefail is set).
export type Segment = { text: string; piped: boolean; after: string }

type Op = { len: number; piped: boolean }

const operatorAt = (c: string, i: number): Op | null => {
  const ch = c[i]
  const next = c[i + 1]
  if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) return { len: 2, piped: false }
  if (ch === '|') return { len: 1, piped: true }
  if (ch === '&' && (c[i - 1] === '>' || next === '>')) return null // a redirection (2>&1, &>), not a background operator
  return ch === ';' || ch === '\n' || ch === '&' ? { len: 1, piped: false } : null
}

// The index just past the quoted chunk that opens at i (the whole rest of the command when unterminated).
export const quotedEnd = (c: string, i: number): number => {
  const quote = c[i]
  let j = i + 1
  while (j < c.length && c[j] !== quote) j += quote === '"' && c[j] === '\\' ? 2 : 1
  return Math.min(j + 1, c.length)
}

// The index just past a heredoc that opens at i (`<<'EOF'`), body included: it runs from the next line
// to the line that is exactly the delimiter. null when none opens at i.
const heredocEnd = (c: string, i: number): number | null => {
  const open = /^<<-?\s*(["']?)([A-Za-z_][\w-]*)\1/.exec(c.slice(i))
  if (open === null) return null
  let pos = c.indexOf('\n', i)
  while (pos >= 0 && pos < c.length) {
    const next = c.indexOf('\n', pos + 1)
    const stop = next < 0 ? c.length : next
    if (c.slice(pos + 1, stop).trim() === open[2]) return stop
    pos = next
  }
  return c.length
}

// The command's simple commands in order. Splits at `&&`, `||`, `;`, newline, `&` and `|` outside
// quotes and heredocs. `$( )` and `( )` are not entered.
export const segmentsOf = (command: string): Segment[] => {
  const out: Segment[] = []
  let cur = ''
  const flush = (piped: boolean, after: string) => {
    const text = cur.trim()
    if (text !== '') out.push({ text: text.slice(0, MAX_SEGMENT), piped, after })
    cur = ''
  }
  let i = 0
  while (i < command.length) {
    const c = command[i]!
    const end = c === '"' || c === "'" ? quotedEnd(command, i) : c === '\\' ? i + 2 : heredocEnd(command, i)
    const op = end === null ? operatorAt(command, i) : null
    if (end !== null) {
      cur += command.slice(i, end)
      i = end
    } else if (op !== null) {
      flush(op.piped, command.slice(i, i + op.len))
      i += op.len
    } else {
      cur += c
      i++
    }
  }
  flush(false, '')
  return out
}

const PREFIX = String.raw`(?:^|[\s(])(?:env\s+)?(?:\w+=\S*\s+)*`
const git = (verb: string) => new RegExp(`${PREFIX}git(?:\\s+-C\\s+\\S+|\\s+-c\\s+\\S+)*\\s+${verb}\\b`)
const gh = (verb: string) => new RegExp(`${PREFIX}gh\\s+pr\\s+${verb}\\b`)
export const RE = {
  commit: git('commit'),
  revert: git('revert'),
  reset: git('reset'),
  push: git('push'),
  create: gh('create'),
  merge: gh('merge'),
  close: gh('close'),
  comment: gh('comment'),
}

export const hasPipefail = (command: string): boolean => /\bpipefail\b/.test(command)

// The exit status of segment `idx`, from the exit status of the whole call (`callExit`: true 0, false
// non-zero, null unreadable). A Bash call has one status, the last command's; it is the segment's
// only when everything from the segment to the end is joined by `&&` (a `;`, newline or `&` after it
// hides it, a pipe hides it unless pipefail) and no `||` anywhere can have absorbed a failure. A
// success (0) of such a chain is the segment's success. A failure is the segment's only when it is the
// one runner of the call (`runners` = 1): with several, which one failed is not readable. null: not
// attributable.
export const attributed = (segs: readonly Segment[], idx: number, callExit: boolean | null, runners: number, pipefail: boolean): boolean | null => {
  if (callExit === null || segs.some((s) => s.after === '||')) return null
  if (!segs.slice(idx, -1).every((s) => s.after === '&&' || (pipefail && s.after === '|'))) return null
  return callExit ? true : runners === 1 ? false : null
}
