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
// request. Without a base the ladder never raises. `loop` is the tool-loop rung the insights
// calibrated for the phase main is in (calibration.ts); medium without one. It is a ceiling like
// the rest: it never lifts a request above its base.
export const effortFor = (
  model: string,
  index: number,
  current: unknown,
  pressure: Pressure,
  base?: Effort,
  loop: Effort = 'medium',
): Effort | undefined => {
  const have = isEffort(current) ? current : defaultEffort(model)
  const now = base ?? have
  const ceiling: Effort = index === 0 ? (pressure === 'none' ? now : 'medium') : pressure === 'none' ? loop : 'low'
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

// A subagent is not touched by pressure: the model and the effort the orchestrator designed (the call's,
// else the definition's) run as designed, whatever the quota or the context. Quota limits how many
// subagents run at once instead (concurrency.ts).

// Memory offload (offload.ts): a result of these tools past the threshold is written whole to a
// file. Only tools whose output is a stream (not a document); a third-party tool's is not ours.
export const OFFLOAD_TOOLS = new Set(['Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch'])

// source: the rule of thumb the context breakdown uses, about four characters a token.
export const CHARS_PER_TOKEN = 4

// The effort a request carries now: its own setting, else the model's default.
export const currentEffort = (model: string, current: unknown): Effort =>
  isEffort(current) ? current : defaultEffort(model)

// source: effort-calibration.md task table, "genuinely stuck / surprising result → high".
export const STUCK_ERRORS = 3 // source: own choice, three tool errors in a row is a loop, not a slip
const LADDER: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const escalate = (effort: Effort): Effort => {
  const i = LADDER.indexOf(effort)
  return i < 0 || i >= LADDER.indexOf('high') ? effort : (LADDER[i + 1] ?? effort)
}

// A tool_result's content as the Messages API spells it: a string, or text blocks (joined here).
export const resultText = (content: unknown): string | undefined => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const texts = content
    .map((b) => b as { type?: string; text?: string })
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
  return texts.length === content.length ? texts.join('\n') : undefined
}

// Exact counts, thousands grouped by a space: "119 304" (the design system's data surface).
export const group = (n: number): string =>
  String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
