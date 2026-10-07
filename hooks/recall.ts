// Pure reading of a Cortex tool call for the transcript rows (ToolUse, ToolResult).

export type RecallHit = {
  id: string
  score?: number
  heat?: number
  domain?: string
  source?: string
  content: string
}

export type RecallView = {
  count: number
  receipt?: number
  intent?: string
  dropped?: number
  shown: RecallHit[]
  hidden: number
}

// source: own choice, the rows a result shows before "n more"; the full list stays in ctrl+o
export const SHOWN_HITS = 5
// source: own choice, one transcript line per hit
const GIST_CHARS = 100

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

// An MCP result reaches the row as text, as MCP content blocks, or as an object.
export const outputText = (output: unknown): string => {
  if (typeof output === 'string') return output
  const content = (output as { content?: unknown } | null)?.content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b as { type?: string; text?: string }).text)
      .filter((t): t is string => typeof t === 'string')
      .join('\n')
  }
  return output === undefined ? '' : JSON.stringify(output)
}

// Shape-driven: anything without a `memories` array is left to the engine's own row.
export const parseRecall = (text: string): RecallView | undefined => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  const obj = raw as Record<string, unknown> | null
  const list = obj?.memories
  if (obj === null || typeof obj !== 'object' || !Array.isArray(list)) return undefined
  const hits: RecallHit[] = list.map((m) => {
    const r = m as Record<string, unknown>
    return {
      id: String(r.memory_id ?? '?'),
      score: num(r.score),
      heat: num(r.heat),
      domain: str(r.domain),
      source: str(r.source),
      content: oneLine(str(r.content) ?? '', GIST_CHARS),
    }
  })
  return {
    count: num(obj.count) ?? hits.length,
    receipt: num(obj.receipt_id),
    intent: str(obj.intent),
    dropped: num(obj.low_signal_dropped),
    shown: hits.slice(0, SHOWN_HITS),
    hidden: Math.max(0, hits.length - SHOWN_HITS),
  }
}

// The input field that says what the call is about, first present wins.
const GIST_KEYS = ['query', 'content', 'title', 'domain', 'memory_id'] as const

export const inputGist = (input: unknown): string => {
  const obj = (input ?? {}) as Record<string, unknown>
  for (const key of GIST_KEYS) {
    const v = obj[key]
    if (typeof v === 'string' && v !== '') return oneLine(v, 80)
    if (typeof v === 'number') return String(v)
  }
  return ''
}
