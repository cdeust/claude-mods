// The classifier: Apple's on-device model, `/usr/bin/fm`, asked which class a delegation's brief belongs to.
// Pure of the engine: the caller hands in `run` (`$.process.run`), so a test can stub it. Every way it can fail
// is a named reason, never a silent default: the caller falls back to the regex and records why.

import type { Brief, Class } from './route'
import { CLASSES } from './route'

export const FM = '/usr/bin/fm'
// Aligned with zetetic-genius CLASSIFIER_TIMEOUT_MS. A cold first call takes 7-19 s (measured 2026-10-29): the
// session start warms the model, and a call that still times out falls back to the regex.
export const TIMEOUT_MS = 4000

// source: README "The classifier call", measured 2026-10-29 with /usr/bin/fm. The context holds ~8125 fm tokens, instructions included; English filler ran at
// ~2 characters per token, taken here as the worst case. The budget is in characters of the brief.
export const LIMIT_TOKENS = 8125
const RESERVE_TOKENS = 256 // the answer
const SAFETY_TOKENS = 200
const CHARS_PER_TOKEN = 2
export const MIN_BUDGET = 400

export const INSTRUCTIONS = `Classify a task brief that an orchestrator hands to a subagent. Answer with the class and a reason of at most 12 words.
read: mechanical lookup, listing or search whose result the caller can check.
build: implement, fix, refactor, write tests or run a build against a design that is already known.
judge: review, audit, security, design, experiment, measurement, or any answer the caller cannot check.
critical: irreversible or security-critical decisions, multi-system architecture.`

export const OVERFLOW = "exceeded the model's context size"

export const initialBudget = (): number =>
  (LIMIT_TOKENS - RESERVE_TOKENS - SAFETY_TOKENS) * CHARS_PER_TOKEN - INSTRUCTIONS.length

const MARK = '\n[…]\n'

// Head two thirds, tail one third, the marker between: the brief's start says what is asked, its end what is expected.
export function fit(text: string, budget: number): string {
  if (text.length <= budget) return text
  const room = Math.max(0, budget - MARK.length)
  const head = Math.floor((room * 2) / 3)
  return text.slice(0, head) + MARK + text.slice(text.length - (room - head))
}

export function brief(task: Brief, budget: number): string {
  const text = `description: ${task.description ?? ''}\nsubagent_type: ${task.subagent_type ?? 'general-purpose'}\nprompt: ${task.prompt ?? ''}`
  return fit(text, budget)
}

export type Run = (
  argv: readonly string[],
  init: { stdin: string; timeoutMs: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export type Failure = 'fm-absent' | 'fm-timeout' | 'fm-exit' | 'fm-overflow' | 'fm-unparseable' | 'fm-error'
export type Answer =
  | { ok: true; cls: Class; why: string; budget: number }
  | { ok: false; failure: Failure; budget: number }

export function parse(stdout: string): { cls: Class; why: string } | null {
  try {
    const o = JSON.parse(stdout) as { class?: unknown; reason?: unknown }
    if (typeof o.class !== 'string' || !Object.hasOwn(CLASSES, o.class)) return null
    return { cls: o.class as Class, why: typeof o.reason === 'string' ? o.reason.slice(0, 120) : '' }
  } catch {
    return null
  }
}

// What a rejected `$.process.run` means (the engine's own messages, probed 2026-10-29 on 2.1.312):
// "failed to start: ENOENT" (no such binary) and "aborted: still running after Nms" (the timeout).
export function failureOf(err: unknown): Failure {
  // An engine without `$.process` (CI pins 2.1.306): the noun is undefined and the call is a TypeError.
  if (err instanceof TypeError) return 'fm-absent'
  const text = String((err as Error | undefined)?.message ?? err)
  if (/failed to start/.test(text)) return 'fm-absent'
  if (/still running|aborted|timed? ?out/i.test(text)) return 'fm-timeout'
  return 'fm-error'
}

// One classification. On the context-overflow error the budget is halved and the call retried once; the budget that
// was last tried comes back so the caller can keep it (it only shrinks).
export async function classify(run: Run, schema: string, task: Brief, budget: number): Promise<Answer> {
  let b = Math.max(MIN_BUDGET, budget)
  for (let attempt = 0; attempt < 2; attempt++) {
    let out: Awaited<ReturnType<Run>>
    try {
      out = await run([FM, 'respond', '--no-stream', '--greedy', '--schema', schema, '-i', INSTRUCTIONS], {
        stdin: brief(task, b),
        timeoutMs: TIMEOUT_MS,
      })
    } catch (err) {
      return { ok: false, failure: failureOf(err), budget: b }
    }
    if (out.exitCode === 0) {
      const got = parse(out.stdout)
      return got === null ? { ok: false, failure: 'fm-unparseable', budget: b } : { ok: true, ...got, budget: b }
    }
    if (!out.stderr.includes(OVERFLOW)) return { ok: false, failure: 'fm-exit', budget: b }
    if (attempt === 1) return { ok: false, failure: 'fm-overflow', budget: b }
    b = Math.max(MIN_BUDGET, Math.floor(b / 2))
  }
  return { ok: false, failure: 'fm-overflow', budget: b }
}
