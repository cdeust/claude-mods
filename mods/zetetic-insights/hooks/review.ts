// The review verdict a `gh pr comment` carries and where its body is: inline (`--body`, a heredoc), in
// a file (`--body-file`, `-F`, `$(cat file)`). Pure and total. The reviewer protocol posts the verdict
// as the first line of the body, which is what is required here: a verdict quoted in prose, or deeper
// in the body, is none.

import { RE, quotedEnd, segmentsOf } from './chain'

const SHA = String.raw`[0-9a-f]{7,40}`

// ZETETIC-REVIEW: APPROVE or REQUEST-CHANGES as the first line of the body (leading whitespace
// allowed), the head sha cited on the next non-empty line.
export const verdictOf = (body: string): { verdict: 'approve' | 'changes'; head?: string } | null => {
  const m = /^\s*ZETETIC-REVIEW:[ \t]*(APPROVE|REQUEST-CHANGES)\b[^\n]*(?:\n|$)((?:[ \t]*\n)*[^\n]*)/.exec(body)
  if (m === null) return null
  const head = new RegExp(`^[ \\t]*(?:head|sha|commit)?[: ]*(${SHA})\\b`, 'i').exec((m[2] ?? '').trimStart())?.[1]
  return { verdict: m[1] === 'APPROVE' ? 'approve' : 'changes', ...(head === undefined ? {} : { head: head.toLowerCase() }) }
}

// The text of the first heredoc in `text` (from the line after its opener to the delimiter line), null when none.
const heredocBody = (text: string): string | null => {
  const open = /<<-?\s*(["']?)([A-Za-z_][\w-]*)\1[^\n]*\n/.exec(text)
  if (open === null) return null
  const lines = text.slice(open.index + open[0].length).split('\n')
  const stop = lines.findIndex((l) => l.trim() === open[2])
  return (stop < 0 ? lines : lines.slice(0, stop)).join('\n')
}

// The value of a `--body`/`-b` flag on the command's first line: a quoted string (a `$(cat <<EOF` heredoc
// inside it is the body), or one word. null: the flag's value is not readable from the text (a variable).
const flagValue = (segment: string): string | null | undefined => {
  const first = segment.indexOf('\n') < 0 ? segment.length : segment.indexOf('\n')
  const flag = /(?:^|\s)(?:-b|--body)(?:=|\s+)/.exec(segment.slice(0, first))
  if (flag === null) return undefined
  const start = flag.index + flag[0].length
  const quote = segment[start]
  if (quote === '"' || quote === "'") {
    const end = quotedEnd(segment, start)
    const inner = segment.slice(start + 1, segment[end - 1] === quote && end - 1 > start ? end - 1 : end)
    return inner.startsWith('$(') ? heredocBody(inner) : inner
  }
  const word = /^\S*/.exec(segment.slice(start))?.[0] ?? ''
  return word.startsWith('$') ? null : word
}

// The body a `gh pr comment` segment carries in its own text: the flag's value, or the heredoc that
// `--body-file -` reads. null when the body is elsewhere (a file) or not readable (a variable).
export const inlineBodyOf = (segment: string): string | null => {
  const value = flagValue(segment)
  if (value !== undefined) return value
  return /(?:--body-file|-F)[ =]-(?:\s|$)/.test(segment) ? heredocBody(segment) : null
}

const unquote = (word: string): string => word.replace(/^["']|["']$/g, '')

// A review body kept in a file: `--body-file <path>`, `-F <path>` or `--body "$(cat <path>)"`. `path` is
// resolved through the `cd <dir> &&` that precede the comment (the register resolves what is still
// relative against the session cwd); null when a `cd` target is a variable or a glob, so the file cannot
// be located. `-` (the heredoc already in the command) is no file.
export type BodyFileRef = { path: string | null }
export const bodyFileOf = (command: string): BodyFileRef | null => {
  let dir = ''
  let known = true
  for (const seg of segmentsOf(command)) {
    if (!RE.comment.test(seg.text)) {
      const cd = /^cd\s+("[^"]+"|'[^']+'|\S+)$/.exec(seg.text)
      if (cd === null) continue
      const to = unquote(cd[1]!)
      if (/[$`~*?]/.test(to) || to === '-') known = false
      else dir = to.startsWith('/') ? to : dir === '' ? to : `${dir.replace(/\/+$/, '')}/${to}`
      continue
    }
    const line = seg.text.split('\n')[0]!
    const file = /(?:^|\s)(?:--body-file|-F)[ =]("[^"]+"|'[^']+'|\S+)/.exec(line)?.[1] ?? /\$\(\s*cat\s+("[^"]+"|'[^']+'|[^\s)]+)\s*\)/.exec(line)?.[1]
    if (file === undefined || file === '-') return null
    const path = unquote(file)
    if (path.startsWith('/') || path.startsWith('~')) return { path }
    return { path: known ? (dir === '' ? path : `${dir.replace(/\/+$/, '')}/${path}`) : null }
  }
  return null
}
