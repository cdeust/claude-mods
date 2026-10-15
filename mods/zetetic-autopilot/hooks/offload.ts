// Lossless offload: a stream tool's result past the threshold is written whole to a file in the
// session's own tool-results directory, and the model reads a preview, the path, the size and an
// instruction to Read or grep the file. The threshold and the preview bound what enters the
// context; they never bound what is kept. Pure: the plan says what to write and what to show, the
// register file does the writing.

// source: Claude Code 2.1.300 persists a tool result past `ise(name, maxResultSizeChars, ceiling)`
// itself: Bash 30000 (`bashOutputMaxChars` default), Grep 20000, Glob and WebSearch 50000 (their
// 100000 is capped by the 50000 ceiling), WebFetch 50000 (read in the binary's strings, 2026-10-15;
// docs: code.claude.com tools-reference). 30000 is the native Bash default, so a result the engine
// already keeps (Grep past 20000, Bash past 30000) is never wrapped twice and Glob, WebFetch and
// WebSearch gain the 30000..50000 band the engine leaves inline.
export const DEFAULT_THRESHOLD_CHARS = 30000
// source: the preview the engine leaves in context for a result it persisted (`oxe = 2000`).
export const DEFAULT_PREVIEW_CHARS = 2000

// source: the engine's file API rejects a write over 4 MiB (index.d.ts, `$.fs`); a UTF-16 code unit
// is at most 3 UTF-8 bytes and a surrogate pair 4, so 1 000 000 units are at most 4 000 000 bytes.
export const PART_CHARS = 1_000_000

// The engine's own pointers to what it already keeps (`<persisted-output>`) or could not keep
// (`<truncated-output>`): a result that starts with one is not wrapped again.
const NATIVE_MARKERS = ['<persisted-output>', '<truncated-output>']
const MARKER = 'zetetic-autopilot-offload'

export type OffloadOptions = { thresholdChars: number; previewChars: number }

export type OffloadFile = { path: string; text: string }
export type OffloadPlan = { files: OffloadFile[]; message: string; chars: number; lines: number }

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0

// The options as the user set them, each checked: a value that is not a positive whole number is
// named, and the default stands in its place. Left unchecked, NaN would make every result "past"
// the threshold.
export const offloadOptions = (
  threshold: unknown,
  preview: unknown,
): { options: OffloadOptions; problems: string[] } => {
  const problems: string[] = []
  const pick = (name: string, value: unknown, fallback: number): number => {
    if (value === undefined) return fallback
    if (isCount(value)) return value
    problems.push(`${name}=${JSON.stringify(value)} is not a positive whole number; using ${fallback}`)
    return fallback
  }
  const thresholdChars = pick('offload_threshold_chars', threshold, DEFAULT_THRESHOLD_CHARS)
  const asked = pick('offload_preview_chars', preview, DEFAULT_PREVIEW_CHARS)
  // A preview as long as the result would only add the pointer's lines to it.
  const previewChars = Math.min(asked, thresholdChars)
  if (previewChars < asked) problems.push(`offload_preview_chars=${asked} is past the threshold; using ${previewChars}`)
  return { options: { thresholdChars, previewChars }, problems }
}

// The directory the engine keeps this session's tool results in: the transcript
// `<projects>/<project>/<session>.jsonl` names it `<projects>/<project>/<session>/tool-results`.
// Undefined when the path is not that of the session `sessionId` (a /clear or a resume moved on).
export const toolResultsDir = (transcriptPath: string | undefined, sessionId: string): string | undefined => {
  if (transcriptPath === undefined || !transcriptPath.endsWith('.jsonl')) return undefined
  const stem = transcriptPath.slice(0, -'.jsonl'.length)
  const sep = stem.includes('/') || !stem.includes('\\') ? '/' : '\\'
  return stem.endsWith(`${sep}${sessionId}`) ? `${stem}${sep}tool-results` : undefined
}

// A tool_use id is `toolu_...` or `call_...`; anything else a file name could not carry is replaced.
const fileSafe = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_')

// Splits at PART_CHARS, never between the two halves of a surrogate pair; the parts joined are the text.
export const parts = (text: string): string[] => {
  const out: string[] = []
  let at = 0
  while (at < text.length) {
    let end = Math.min(at + PART_CHARS, text.length)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1
    out.push(text.slice(at, end))
    at = end
  }
  return out
}

// The start of the text to show: up to `limit` characters, cut at a line break when one falls in the
// second half (the engine's own rule for its preview), never inside a surrogate pair.
export const previewOf = (text: string, limit: number): string => {
  let end = Math.min(limit, text.length)
  const last = text.charCodeAt(end - 1)
  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1
  const head = text.slice(0, end)
  if (end === text.length) return head
  const lineEnd = head.lastIndexOf('\n')
  return lineEnd > end / 2 ? head.slice(0, lineEnd) : head
}

const count = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

// pre:  `dir` is the session's tool-results directory, `toolUseId` the block's id, `joined` says the
//       text is several text blocks joined by a newline.
// post: undefined when the text is within the threshold or is one of the engine's own pointers;
//       otherwise `files` hold the text exactly (their texts joined are `text`, byte for byte) and
//       `message` is the preview, the path or paths, the size in characters and lines, and the
//       instruction to read the file. Nothing in it is a cut of the text except the preview, which
//       is named as the start.
export const planOffload = (
  text: string,
  toolUseId: string,
  dir: string,
  options: OffloadOptions,
  joined = false,
): OffloadPlan | undefined => {
  if (text.length <= options.thresholdChars) return undefined
  if (NATIVE_MARKERS.some((m) => text.startsWith(m))) return undefined
  const sep = dir.includes('/') || !dir.includes('\\') ? '/' : '\\'
  const pieces = parts(text)
  const name = `autopilot-${fileSafe(toolUseId)}`
  const files = pieces.map((piece, i) => ({
    path: `${dir}${sep}${name}${pieces.length === 1 ? '' : `.${i + 1}`}.txt`,
    text: piece,
  }))
  const lines = text.split('\n').length
  const where =
    files.length === 1
      ? `Full output saved to: ${files[0]?.path}`
      : `Full output saved in ${files.length} files of at most ${count(PART_CHARS)} characters, to be read in order:\n${files.map((f) => f.path).join('\n')}`
  const preview = previewOf(text, options.previewChars)
  const message = [
    `<${MARKER}>`,
    `Output too large (${count(text.length)} characters, ${count(lines)} lines). ${where}`,
    ...(joined ? ['The file holds the result\'s text blocks joined by a newline.'] : []),
    `Preview (the first ${count(preview.length)} characters):`,
    preview,
    'Nothing was removed: Read or grep the file for the rest.',
    `</${MARKER}>`,
  ].join('\n')

  return { files, message, chars: text.length, lines }
}
