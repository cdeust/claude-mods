// What a Bash tool call shows about the fate of the work, read live at `tool.call` (no transcript):
// a commit, a revert, a test run and its exit status, a push, a pull request created, reviewed,
// merged or closed. Pure and total: any command and result go in, the closed list of events comes
// out, nothing throws. The command text is the primary source; the Bash result's structured
// `gitOperation` (claude-code-tools Bash output) corroborates it and names the sha and the PR number
// when the command does not. Where each event comes from, and what it cannot tell, is written in
// docs/insights-outcome-model.md.

import type { EventSource, FrictionKind, LiveFriction, OutcomeEvent } from '../types'
import { signatureOf, toolErrorKind } from './friction'

export const MAX_EVENTS = 40 // source: own choice, events one turn record keeps (~120 bytes each, 5 KB): a turn that ran a test loop folds repeats (foldEvent); the rest are counted in eventsDropped
export const MAX_LIVE_FRICTIONS = 10 // source: own choice, friction rows of one turn record, like FRICTION_TOP/3 of a session's rows
const MAX_SEGMENT = 4000 // source: own choice, characters of a command classified; a longer one is a script written inline, and its first lines name its runner
const LABEL_CAP = 40 // source: own choice, characters of a test label

type Segment = { text: string; piped: boolean }

// The command's simple commands in order. Splits at `&&`, `||`, `;`, newline, `&` and `|` outside
// quotes and heredocs; `piped` marks a segment whose output goes into a pipe (its exit status is then
// not the command's, unless pipefail is set). `$( )` and `( )` are not entered.
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
const quotedEnd = (c: string, i: number): number => {
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

export const segmentsOf = (command: string): Segment[] => {
  const out: Segment[] = []
  let cur = ''
  const flush = (piped: boolean) => {
    const text = cur.trim()
    if (text !== '') out.push({ text: text.slice(0, MAX_SEGMENT), piped })
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
      flush(op.piped)
      i += op.len
    } else {
      cur += c
      i++
    }
  }
  flush(false)
  return out
}

const PREFIX = String.raw`(?:^|[\s(])(?:env\s+)?(?:\w+=\S*\s+)*`
const git = (verb: string) => new RegExp(`${PREFIX}git(?:\\s+-C\\s+\\S+|\\s+-c\\s+\\S+)*\\s+${verb}\\b`)
const gh = (verb: string) => new RegExp(`${PREFIX}gh\\s+pr\\s+${verb}\\b`)
const RE = {
  commit: git('commit'),
  revert: git('revert'),
  reset: git('reset'),
  push: git('push'),
  create: gh('create'),
  merge: gh('merge'),
  close: gh('close'),
  comment: gh('comment'),
}

// source: the test and gate commands this repo's CI and README "Developing" name, plus the other
// runners the owner's projects use (pytest, bun, npm/pnpm/yarn, node --test, cargo, go, swift). A
// closed list, so "a test command" is one definition; a runner not in it is not seen (the
// outcome model says so).
const TESTS: readonly (readonly [RegExp, (m: RegExpExecArray) => string])[] = [
  [/(?:^|\s)(?:python3?\s+-m\s+)?pytest\b/, () => 'pytest'],
  [/\bbun\s+test\b/, () => 'bun test'],
  [/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/, () => 'npm test'],
  [/\bnode\b[^|&;]*\s--test\b/, () => 'node --test'],
  [/\bclaude\s+plugin\s+test\b/, () => 'claude plugin test'],
  [/\bclaude\s+plugin\s+validate\b/, () => 'claude plugin validate'],
  [/\bcargo\s+test\b/, () => 'cargo test'],
  [/\bgo\s+test\b/, () => 'go test'],
  [/\bswift\s+test\b/, () => 'swift test'],
  [/\btsc\b[^|&;]*--noEmit\b/, () => 'tsc'],
  [/\bruff\s+(?:check|format\s+--check)\b/, () => 'ruff'],
  [/\bscripts\/(check[-_][\w.-]+)/, (m) => `gate:${m[1]}`],
  [/\bbuild-codex\.mjs\s+--check\b/, () => 'gate:build-codex'],
]

export const testLabel = (segment: string): string | null => {
  for (const [re, label] of TESTS) {
    const m = re.exec(segment)
    if (m !== null) return label(m).slice(0, LABEL_CAP)
  }
  return null
}

export type GitOperation = {
  commit?: { sha?: string; kind?: string }
  push?: { branch?: string }
  pr?: { number?: number; url?: string; action?: string }
}
export type BashResult = { isError?: boolean; deny?: string; text?: string; result?: unknown }

const gitOperationOf = (res: BashResult): GitOperation => {
  const r = typeof res.result === 'object' && res.result !== null ? (res.result as { gitOperation?: unknown }) : {}
  return typeof r.gitOperation === 'object' && r.gitOperation !== null ? (r.gitOperation as GitOperation) : {}
}

const resultText = (res: BashResult): string => {
  const r = typeof res.result === 'object' && res.result !== null ? (res.result as { stdout?: unknown }) : {}
  return `${res.text ?? ''}\n${typeof r.stdout === 'string' ? r.stdout : ''}`
}

// source: friction.ts BASH_EXIT, measured 2026-10-14 on 8 of 10 transcript tool errors: a Bash
// command that exits non-zero is an errored call whose text starts with this line. The typed Bash
// result carries no exit code (claude-code-tools Bash output: stdout, stderr, interrupted).
const EXIT_LINE = /^Exit code (\d+)/

// A test's exit status: true for 0, false for a non-zero exit, null when it cannot be read (an
// errored call without the exit line: interrupted, timed out, refused).
export const exitOk = (res: BashResult): boolean | null => {
  if (res.isError !== true) return true
  const m = EXIT_LINE.exec((res.text ?? '').trimStart())
  return m === null ? null : m[1] === '0'
}

const SHA = String.raw`[0-9a-f]{7,40}`
// source: git's own commit summary line, `[branch sha] subject` (git commit stdout).
const COMMIT_LINE = new RegExp(`^\\[[^\\]\\n]*?\\s(${SHA})\\]`, 'm')

const prNumber = (arg: string | undefined): { repo: string; n: string } | null => {
  if (arg === undefined) return null
  const url = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(arg)
  if (url !== null) return { repo: url[1]!, n: url[2]! }
  return /^#?(\d+)$/.test(arg) ? { repo: '', n: arg.replace('#', '') } : null
}

export const prKey = (repo: string, n: string): string => `${repo}#${n}`

// Two PR keys name the same pull request when their numbers agree and their repositories do, or one
// of them names none (the call said `gh pr merge 23`).
export const samePr = (a: string | undefined, b: string | undefined): boolean => {
  if (a === undefined || b === undefined) return false
  const [ar, an] = a.split('#')
  const [br, bn] = b.split('#')
  return an === bn && (ar === '' || br === '' || ar === br)
}

const repoFlag = (segment: string): string => /(?:--repo|-R)[ =]([\w.-]+\/[\w.-]+)/.exec(segment)?.[1] ?? ''

// The first positional argument after the verb (not a flag, not a flag's value): the PR number or URL.
const positional = (segment: string, verb: string): string | undefined => {
  const rest = segment.slice(segment.search(new RegExp(`\\b${verb}\\b`)) + verb.length)
  const tokens = rest.trim().split(/\s+/)
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (/^-(?:b|F|R|t|B|r|a|l|m|M)$|^--(?:body|body-file|repo|title|base|reviewer|assignee|label|milestone)$/.test(t)) {
      i++
      continue
    }
    if (t.startsWith('-')) continue
    return t.replace(/^["']|["']$/g, '')
  }
  return undefined
}

// The review verdict a `gh pr comment` body opens with (the reviewer protocol): ZETETIC-REVIEW:
// APPROVE or REQUEST-CHANGES at the start of a line, the head sha cited on the next non-empty line.
export const verdictOf = (body: string): { verdict: 'approve' | 'changes'; head?: string } | null => {
  const m = /(?:^|[\n"'])[ \t]*ZETETIC-REVIEW:[ \t]*(APPROVE|REQUEST-CHANGES)\b[^\n]*(?:\n|$)((?:[ \t]*\n)*[^\n]*)/.exec(body)
  if (m === null) return null
  const head = new RegExp(`^[ \\t]*(?:head|sha|commit)?[: ]*(${SHA})\\b`, 'i').exec((m[2] ?? '').trimStart())?.[1]
  return { verdict: m[1] === 'APPROVE' ? 'approve' : 'changes', ...(head === undefined ? {} : { head: head.toLowerCase() }) }
}

// A review body kept in a file: `gh pr comment ... --body-file <path>` or `-F <path>` (not `-`, which
// reads the heredoc already in the command). The register reads it; a path it cannot read is a verdict
// of 'unknown'.
export const bodyFileOf = (command: string): string | null => {
  if (!RE.comment.test(command)) return null
  const m = /(?:--body-file|-F)[ =]("[^"]+"|'[^']+'|\S+)/.exec(command)
  const path = m?.[1]?.replace(/^["']|["']$/g, '')
  return path === undefined || path === '-' ? null : path
}

export type BashCall = {
  command: string
  at: number
  agent?: string
  res: BashResult
  // The text of the file the command's --body-file names: a string read, null unreadable, undefined no file named.
  bodyFile?: string | null
}

const resetBack = (segment: string): number | undefined => {
  const m = /\bHEAD(?:~(\d+)|(\^+))/.exec(segment)
  if (m === null) return undefined
  return m[1] !== undefined ? Number(m[1]) : (m[2]?.length ?? 1)
}

const shasIn = (segment: string): string[] => (segment.match(new RegExp(`(?<![\\w-])${SHA}(?![\\w-])`, 'g')) ?? []).map((s) => s.toLowerCase())

type Ctx = { base: { at: number; agent?: string }; op: GitOperation; text: string; call: BashCall }

const srcOf = (fromCommand: boolean, fromOp: boolean): EventSource => (fromCommand && fromOp ? 'both' : fromOp ? 'git-operation' : 'command')

// A test or gate run of one segment, with its exit status (null when a pipe hides it).
const testEvent = (seg: Segment, label: string, ctx: Ctx): OutcomeEvent => {
  const piped = seg.piped && !/\bpipefail\b/.test(ctx.call.command)
  return { ...ctx.base, kind: 'test', src: 'command', label, ok: piped ? null : exitOk(ctx.call.res) }
}

const prOf = (arg: { repo: string; n: string } | null, segment: string): { pr?: string } => (arg === null ? {} : { pr: prKey(arg.repo || repoFlag(segment), arg.n) })

const createEvent = (s: string, ctx: Ctx): OutcomeEvent => {
  const { op, text } = ctx
  const found = prNumber(op.pr?.url) ?? prNumber(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/.exec(text)?.[0]) ?? (op.pr?.number === undefined ? null : { repo: '', n: String(op.pr.number) })
  return { ...ctx.base, kind: 'pr-create', src: srcOf(true, op.pr?.action === 'created'), ...prOf(found, s), ok: true }
}

const mergeOrCloseEvent = (s: string, ctx: Ctx): OutcomeEvent => {
  const merging = RE.merge.test(s)
  const arg = prNumber(positional(s, merging ? 'merge' : 'close')) ?? (ctx.op.pr?.number === undefined ? null : { repo: '', n: String(ctx.op.pr.number) })
  const agreed = ctx.op.pr?.action === (merging ? 'merged' : 'closed')
  return { ...ctx.base, kind: merging ? 'pr-merge' : 'pr-close', src: srcOf(true, agreed), ...prOf(arg, s), ok: true }
}

// A review verdict, from the comment body: inline in the command, or the file the register read.
const verdictEvent = (s: string, ctx: Ctx): OutcomeEvent[] => {
  const body = ctx.call.bodyFile !== undefined ? ctx.call.bodyFile : s
  const pr = prOf(prNumber(positional(s, 'comment')), s)
  const v = body === null ? null : verdictOf(body)
  if (v !== null) return [{ ...ctx.base, kind: 'verdict', src: srcOf(true, ctx.op.pr?.action === 'commented'), ...pr, verdict: v.verdict, ...(v.head === undefined ? {} : { head: v.head }), ok: true }]
  return body === null ? [{ ...ctx.base, kind: 'verdict', src: 'command', ...pr, verdict: 'unknown', ok: true }] : []
}

const resetEvent = (s: string, ctx: Ctx): OutcomeEvent[] => {
  const back = resetBack(s)
  if (!/--(?:hard|soft|mixed|keep|merge)\b/.test(s) && back === undefined && shasIn(s).length === 0) return [] // an unstage, not a reset of commits
  const target = shasIn(s)[0] ?? (back === undefined ? 'head' : `head~${back}`)
  return [{ ...ctx.base, kind: 'reset', src: 'command', sha: target, ...(back === undefined ? {} : { back }), ok: true }]
}

const revertEvents = (s: string, ctx: Ctx): OutcomeEvent[] => {
  const shas = shasIn(s.slice(s.search(RE.revert)))
  const targets = shas.length > 0 ? shas : /\bHEAD\b/.test(s) ? ['head'] : []
  return targets.map((sha) => ({ ...ctx.base, kind: 'revert' as const, src: 'command' as const, sha, ok: true }))
}

const commitEvent = (s: string, ctx: Ctx): OutcomeEvent => {
  const sha = ctx.op.commit?.sha ?? COMMIT_LINE.exec(ctx.text)?.[1]
  const amended = ctx.op.commit?.kind === 'amended' || /--amend\b/.test(s)
  return { ...ctx.base, kind: 'commit', src: srcOf(true, ctx.op.commit !== undefined), ...(sha ? { sha: sha.toLowerCase() } : {}), ...(amended ? { label: 'amended' } : {}), ok: true }
}

// The state-changing events of one segment (a call that errored claims none of them).
const stateEvents = (s: string, ctx: Ctx): OutcomeEvent[] => {
  if (RE.commit.test(s)) return [commitEvent(s, ctx)]
  if (RE.revert.test(s)) return revertEvents(s, ctx)
  if (RE.reset.test(s)) return resetEvent(s, ctx)
  if (RE.push.test(s)) return [{ ...ctx.base, kind: 'push', src: srcOf(true, ctx.op.push !== undefined), ok: true }]
  if (RE.create.test(s)) return [createEvent(s, ctx)]
  if (RE.merge.test(s) || RE.close.test(s)) return [mergeOrCloseEvent(s, ctx)]
  return RE.comment.test(s) ? verdictEvent(s, ctx) : []
}

// The events one Bash call shows, in command order. A call that errored shows only its test runs
// (their exit status is the point) and the git operations `gitOperation` confirms: which segment of a
// failed chain failed is not readable, so no other state change is claimed.
export const eventsOfBash = (call: BashCall): OutcomeEvent[] => {
  const { command, at, res } = call
  if (typeof command !== 'string' || res.deny !== undefined) return []
  const ctx: Ctx = { base: { at, ...(call.agent === undefined ? {} : { agent: call.agent }) }, op: gitOperationOf(res), text: resultText(res), call }
  const out: OutcomeEvent[] = []
  for (const seg of segmentsOf(command)) {
    const label = testLabel(seg.text)
    if (label !== null && !RE.comment.test(seg.text) && !RE.commit.test(seg.text)) out.push(testEvent(seg, label, ctx))
    else if (res.isError !== true) out.push(...stateEvents(seg.text, ctx))
  }
  // A call whose segments showed no commit but whose result says one happened (a wrapper script).
  const sha = ctx.op.commit?.sha
  if (sha !== undefined && !out.some((e) => e.kind === 'commit')) out.push({ ...ctx.base, kind: 'commit', src: 'git-operation', sha: sha.toLowerCase(), ok: true })
  return out
}

const sameEvent = (a: OutcomeEvent, b: OutcomeEvent): boolean =>
  a.kind === b.kind && a.agent === b.agent && a.src === b.src && a.sha === b.sha && a.pr === b.pr && a.label === b.label && a.head === b.head && a.ok === b.ok && a.verdict === b.verdict && a.back === b.back

// One event added to a turn's list: a repeat of the last one is folded into its `n`, past MAX_EVENTS
// the event is counted in `dropped`.
export const foldEvent = (list: { events: OutcomeEvent[]; dropped: number }, e: OutcomeEvent): { events: OutcomeEvent[]; dropped: number } => {
  const last = list.events[list.events.length - 1]
  if (last !== undefined && sameEvent(last, e)) return { events: [...list.events.slice(0, -1), { ...last, n: (last.n ?? 1) + (e.n ?? 1) }], dropped: list.dropped }
  return list.events.length < MAX_EVENTS ? { events: [...list.events, e], dropped: list.dropped } : { events: list.events, dropped: list.dropped + 1 }
}

// The friction a tool call that did not run or failed shows, with the same closed rules as the
// transcript registry (friction.ts toolErrorKind). A plugin's refusal (`deny`) is a harness refusal; a
// Bash command's own non-zero exit is none. null: no friction. The signature is masked and normalised
// by the same function, so a live row and a transcript row of one event are one row.
export const liveFrictionOf = (tool: string, res: BashResult): { kind: FrictionKind; signature: string } | null => {
  if (res.deny !== undefined) return { kind: 'harness-refusal', signature: signatureOf(res.deny) }
  if (res.isError !== true) return null
  const text = res.text ?? ''
  const kind = toolErrorKind(tool, text)
  return kind === null ? null : { kind, signature: signatureOf(text) }
}

export const addFriction = (list: readonly LiveFriction[], f: { kind: FrictionKind; signature: string }): LiveFriction[] => {
  const at = list.findIndex((x) => x.kind === f.kind && x.signature === f.signature)
  if (at >= 0) return list.map((x, i) => (i === at ? { ...x, count: x.count + 1 } : x))
  return list.length < MAX_LIVE_FRICTIONS ? [...list, { ...f, count: 1 }] : [...list]
}
