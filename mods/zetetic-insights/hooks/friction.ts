// What got in the model's way, read from a finished session's transcript. Pure and total: any text
// goes in, rows come out, a line that is not JSON is skipped and counted, nothing throws.

import type { FrictionKind, FrictionRow } from '../types'

// OPERATIONAL DEFINITION (one rule per measure, written once, here). A friction is a transcript
// event that one of the closed rules below matches; whatever no rule matches is not a friction.
// Drawn from the owner's 10 latest transcripts (495 tool results, measured 2026-10-14): tool errors
// are rare (10), and 8 of them were a Bash command's own non-zero exit; hook events are
// `attachment` events named by `attachment.type`, and hook_success (thousands) is not one.

export const FRICTION_TOP = 30 // source: own choice, rows kept per session; the 10 measured sessions held 59 hook events in a few distinct signatures
export const FRICTION_RECURRING = 10 // source: own choice, rows of the recurring list kept in state; the brief and the pane show fewer
export const FRICTION_MIN_SESSIONS = 2 // source: own choice, one session is an incident, two is a pattern
export const SIGNATURE_CAP = 120 // source: spec of the registry, characters kept of a signature

export type Friction = { kind: FrictionKind; signature: string; count: number }

// source: transcripts measured 2026-10-14, `attachment.type` is the hook event's kind. hook_blocking_error
// 27 (all on Stop: 16 "Owned cleanup remains", 5 "CONTEXT SOFT CAP REACHED", 3 "subagent
// reflection(s) pending", 2 redaction gate, 1 checkpoint threshold), hook_non_blocking_error 17
// ("Plugin directory does not exist"), hook_cancelled 15. hook_success and the rest are no friction.
const HOOK_KINDS: Readonly<Record<string, FrictionKind>> = {
  hook_blocking_error: 'hook-block',
  hook_non_blocking_error: 'hook-error',
  hook_cancelled: 'hook-cancelled',
}

// source: the 2 harness refusals of the 10 measured tool errors: "PreToolUse:Bash hook error: ... Bash
// blocked: ..." and "Permission to use Bash with command ... has been denied."
const REFUSAL = /Blocked:|hook error|PreToolUse|denied|permission|not allowed/i
// source: Claude Code's own messages for a tool misused (Edit before Read, an Edit that matches
// nothing, a schema violation); none occurred in the 10 measured tool errors, so this rule is stated
// from the tools' messages, not from the sample.
const MISUSE = /File has not been read|String to replace not found|InputValidationError|unknown (parameter|param|argument|option|field)/i
// source: spec of the registry: an MCP tool's error, or any error that says the link failed.
const MCP_TEXT = /connection|timed out/i
// source: the 8 of 10 measured tool errors that were a Bash command's own failure began with this
// line, the command's output after it: that is the command's result, not the harness's. An output
// saying "Permission denied" is then the command's, not a refusal.
const BASH_EXIT = /^Exit code \d+$/

// The signature normalisation, in this order (spec): quoted strings, /paths, long hex runs, tool-use
// ids, numbers; then cut. The same event on another day, path or id is one signature.
const NORMALISE: readonly (readonly [RegExp, string])[] = [
  [/"[^"\n]*"|(?<!\w)'[^'\n]*'|`[^`\n]*`/g, '<Q>'],
  [/(?<![\w<>])~?\/[^\s"'`,;)\]}]+/g, '<PATH>'],
  [/\b[0-9a-f]{8,}\b/gi, '<HEX>'],
  [/\btoolu_\w+/g, '<ID>'],
  [/\b\d+(?:\.\d+)*\b/g, 'N'],
]

const firstLine = (text: string): string => text.split('\n').find((l) => l.trim() !== '') ?? ''

// source: the two harness refusals read in 2026-10-14 transcripts. "Permission to use Bash with command
// <the whole command, often several lines> has been denied." carries the command, so every denial was
// unique; "PreToolUse:Write hook error: [bash -c '<hook command>']: [decision-gate] BLOCKED: <path>
// would add 12 ... lines. A block ..." carries the hook's command line. Both are reduced before the
// generic rules to what repeats: the tool, and the gate's first sentence.
const DENIED = /^Permission to use (\S+) with command [\s\S]*? has been denied/
const HOOK_ERROR = /^(PreToolUse:\S+ hook error): \[[\s\S]*?\]: ([\s\S]*)$/
const reduced = (text: string): string => {
  const t = text.trim()
  const denied = DENIED.exec(t)
  if (denied !== null) return `Permission to use ${denied[1]} with command <CMD> has been denied`
  const hook = HOOK_ERROR.exec(t)
  if (hook === null) return firstLine(t).trim()
  const gate = hook[2]!.trim()
  const end = gate.search(/\.(\s|$)/)
  return `${hook[1]}: ${firstLine(end < 0 ? gate : gate.slice(0, end)).trim()}`
}

export const signatureOf = (text: string): string => NORMALISE.reduce((s, [re, to]) => s.replace(re, to), reduced(text)).slice(0, SIGNATURE_CAP)

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// A hook event's text: `blockingError` (a string, or the nested { blockingError, command } the engine
// writes), else `stderr`, else `content`; the first that says anything.
const hookText = (a: Record<string, unknown>): string => {
  const b = a.blockingError
  const candidates = [typeof b === 'string' ? b : str(obj(b)?.blockingError), str(a.stderr), str(a.content)]
  return candidates.find((t) => t.trim() !== '') ?? ''
}

// A cancelled hook says nothing; what identifies it is its event and its script (the command's last
// path component, so a plugin's folder or a user's name is not part of it).
const cancelledText = (a: Record<string, unknown>): string => {
  const words = str(a.command).trim().split(/\s+/)
  const word = words.find((w) => w.includes('/')) ?? words[0] ?? ''
  const script = word.replace(/["']/g, '').split('/').pop() ?? ''
  return `${str(a.hookName)}: ${script}${a.timedOut === true ? ' timed out' : ' cancelled'}`
}

const resultText = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => str(obj(b)?.text)).join('\n') : ''

// The kind of a failed tool call, or null when it is none of the closed three.
export const toolErrorKind = (tool: string, text: string): FrictionKind | null => {
  if (tool === 'Bash' && BASH_EXIT.test(firstLine(text).trim())) return null
  if (REFUSAL.test(text)) return 'harness-refusal'
  if (MISUSE.test(text)) return 'tool-misuse'
  if (tool.startsWith('mcp__') || MCP_TEXT.test(text)) return 'mcp-failure'
  return null
}

type Found = { kind: FrictionKind; text: string }

// Lines worth a parse: the rest of a transcript is never a friction.
const CANDIDATE = /"hook_blocking_error"|"hook_non_blocking_error"|"hook_cancelled"|"tool_use"|"tool_result"/

// Every friction event of the transcript in order, and the candidate lines that did not parse.
const scan = (jsonl: string): { found: Found[]; skipped: number } => {
  const found: Found[] = []
  const names = new Map<string, string>()
  let skipped = 0
  for (const line of jsonl.split('\n')) {
    if (!CANDIDATE.test(line)) continue
    let event: Record<string, unknown> | null
    try {
      event = obj(JSON.parse(line))
    } catch {
      skipped += 1
      continue
    }
    if (event === null) continue
    const a = obj(event.attachment)
    const kind = event.type === 'attachment' && a !== null ? HOOK_KINDS[str(a.type)] : undefined
    if (a !== null && kind !== undefined) {
      found.push({ kind, text: kind === 'hook-cancelled' ? cancelledText(a) : hookText(a) })
      continue
    }
    const content = obj(event.message)?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      const block = obj(b)
      if (block?.type === 'tool_use') names.set(str(block.id), str(block.name))
      else if (block?.type === 'tool_result' && block.is_error === true) {
        const text = resultText(block.content)
        const k = toolErrorKind(names.get(str(block.tool_use_id)) ?? '', text)
        if (k !== null) found.push({ kind: k, text })
      }
    }
  }
  return { found, skipped }
}

const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// The frictions of a transcript grouped by (kind, signature), most frequent first, at most
// FRICTION_TOP, with the candidate lines skipped as malformed. The order is total (count, kind,
// signature), so two processes reading the same file write the same value.
export const frictionScan = (jsonl: string): { rows: Friction[]; skipped: number } => {
  const { found, skipped } = scan(typeof jsonl === 'string' ? jsonl : '')
  const grouped = new Map<string, Friction>()
  for (const f of found) {
    const signature = signatureOf(f.text)
    const key = `${f.kind}\u0000${signature}`
    const row = grouped.get(key)
    if (row === undefined) grouped.set(key, { kind: f.kind, signature, count: 1 })
    else row.count += 1
  }
  const rows = [...grouped.values()].sort((a, b) => b.count - a.count || order(a.kind, b.kind) || order(a.signature, b.signature))
  return { rows: rows.slice(0, FRICTION_TOP), skipped }
}

export const frictionsOf = (jsonl: string): Friction[] => frictionScan(jsonl).rows

// The rows that recur: in at least FRICTION_MIN_SESSIONS of the sessions given (one list per session),
// most sessions first, then most occurrences, at most FRICTION_RECURRING. A session counts a row once.
export const recurringFrictions = (perSession: readonly (readonly Friction[])[]): FrictionRow[] => {
  const by = new Map<string, FrictionRow>()
  for (const rows of perSession) {
    const seen = new Set<string>()
    for (const r of rows) {
      const key = `${r.kind}\u0000${r.signature}`
      const row = by.get(key) ?? { kind: r.kind, signature: r.signature, sessions: 0, count: 0 }
      row.count += r.count
      if (!seen.has(key)) row.sessions += 1
      seen.add(key)
      by.set(key, row)
    }
  }
  return [...by.values()]
    .filter((r) => r.sessions >= FRICTION_MIN_SESSIONS)
    .sort((a, b) => b.sessions - a.sessions || b.count - a.count || order(a.kind, b.kind) || order(a.signature, b.signature))
    .slice(0, FRICTION_RECURRING)
}

export const FRICTION_MAX_BYTES = 20 * 1024 * 1024 // source: own choice; the largest of the owner's transcripts measured 2026-10-14 was 4.9 MB (4911342 bytes)

// A transcript that will never be measured: its file is gone, or past FRICTION_MAX_BYTES. A fact about
// the path, the same for every process that writes it.
export type Unavailable = { unavailable: 'missing' | 'too-large' }

// What a stored frictions:<session> value says: its well-formed rows. An unavailable marker is a
// measured session with no rows; anything else (an older or a damaged value) is read as no rows too.
export const rowsOf = (v: unknown): Friction[] =>
  Array.isArray(v)
    ? v.filter((r): r is Friction => typeof r === 'object' && r !== null && typeof (r as Friction).kind === 'string' && typeof (r as Friction).signature === 'string' && Number.isFinite((r as Friction).count))
    : []

// The recurring rows over some sessions of the stored frictions (a session with none stored is not in it).
export const recurringOver = (stored: ReadonlyMap<string, readonly Friction[]>, sessions: Iterable<string>): FrictionRow[] =>
  recurringFrictions([...sessions].flatMap((s) => (stored.has(s) ? [stored.get(s)!] : [])))

export const isUnavailable = (v: unknown): v is Unavailable => {
  const u = typeof v === 'object' && v !== null ? (v as { unavailable?: unknown }).unavailable : undefined
  return u === 'missing' || u === 'too-large'
}
