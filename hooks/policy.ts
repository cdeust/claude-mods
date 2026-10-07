// Pure policy: what the mod would change on a request, a subagent or a tool result.
// Observed (logged) or enforced, the decision is the same function of the same facts.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Pressure = 'none' | 'quota' | 'context'
export type PolicyMode = 'observe' | 'enforce'

// source: platform.claude.com/docs/en/models/haiku-5-5/overview § How it compares (read
// 2026-10-07), the API's default effort per model: Fable 5.1 `high`, Opus 5.5 `medium`,
// Sonnet 5.5 `high`, Haiku 5.5 `medium`. ~/.claude/reference/model-behavior.md § Effort agrees
// on Fable and Opus (Opus `low`/`medium` strong; Sonnet respects effort strictly).
const DEFAULT_EFFORT: { match: string; effort: Effort }[] = [
  { match: 'fable', effort: 'high' },
  { match: 'opus', effort: 'medium' },
  { match: 'sonnet', effort: 'high' },
  { match: 'haiku', effort: 'medium' },
]
const RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }

const isEffort = (v: unknown): v is Effort => typeof v === 'string' && v in RANK

export const defaultEffort = (model: string): Effort => {
  const m = model.toLowerCase()
  return DEFAULT_EFFORT.find((row) => m.includes(row.match))?.effort ?? 'medium'
}

// The owner's ladder (2026-10-07): the first request of a turn keeps its effort, the tool-loop
// requests after it run at medium; under quota or context pressure the loop runs at low and the
// first request drops to medium at most. `base` is the effort the request classifier chose for
// this turn (classify.ts); it replaces the session setting as the rung the ladder starts from,
// so a `routine` turn runs its whole loop at low and a `critical` one keeps high on its first
// request. Without a base the ladder never raises.
export const effortFor = (
  model: string,
  index: number,
  current: unknown,
  pressure: Pressure,
  base?: Effort,
): Effort | undefined => {
  const have = isEffort(current) ? current : defaultEffort(model)
  const now = base ?? have
  const ceiling: Effort = index === 0 ? (pressure === 'none' ? now : 'medium') : pressure === 'none' ? 'medium' : 'low'
  const target = RANK[ceiling] < RANK[now] ? ceiling : now
  return target === have ? undefined : target
}

// Pressure: the five-hour window past the threshold, else the context past its warn mark.
export const pressureOf = (
  rateLimits: readonly { kind: string; percentUsed: number }[],
  quotaPercent: number,
  contextBand: 'measured' | 'warn' | 'hard' | 'unknown',
): Pressure => {
  const fiveHour = rateLimits.find((r) => r.kind === 'five_hour')
  if (fiveHour !== undefined && fiveHour.percentUsed >= quotaPercent) return 'quota'
  if (contextBand === 'warn' || contextBand === 'hard') return 'context'
  return 'none'
}

// Subagents under pressure go one notch down, opus/fable to sonnet; sonnet and haiku stay.
// Owner choice 2026-10-07: no protected agent type.
const HEAVY = /opus|fable/i

export const agentModelFor = (
  declared: string | undefined,
  parentModel: string,
  pressure: Pressure,
): string | undefined => {
  if (pressure === 'none') return undefined
  const effective = declared ?? parentModel
  return HEAVY.test(effective) ? 'sonnet' : undefined
}

// Memory leaning: a tool result past the cap keeps its head and tail; the cut is named so the
// model can rerun with a narrower filter. Only tools whose output is a stream (not a document).
export const LEAN_TOOLS = new Set(['Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch'])
const HEAD_SHARE = 0.6 // source: own choice, the start of an output carries the command's answer
const TAIL_SHARE = 0.25 // source: own choice, the end carries the exit status and the last error

export type Lean = { text: string; cut: number }

export const leanText = (text: string, cap: number): Lean | undefined => {
  if (text.length <= cap) return undefined
  const head = text.slice(0, Math.floor(cap * HEAD_SHARE))
  const tail = text.slice(text.length - Math.floor(cap * TAIL_SHARE))
  const cut = text.length - head.length - tail.length
  const marker = `\n[cortex-cockpit cut ${cut} characters here; rerun with a narrower filter if they matter]\n`
  return { text: `${head}${marker}${tail}`, cut }
}

// source: the rule of thumb the context breakdown uses, about four characters a token.
export const CHARS_PER_TOKEN = 4

// The effort a request carries now: its own setting, else the model's default.
export const currentEffort = (model: string, current: unknown): Effort =>
  isEffort(current) ? current : defaultEffort(model)

export type Decision = {
  at: number
  kind: 'effort' | 'model' | 'lean' | 'shape' | 'stuck'
  subject: string
  from: string
  to: string
  applied: boolean
}
