// What the insights hand to Cortex: ONE aggregate memory over the newest finished sessions, which
// replaces itself (supersedes_id). One memory per session was dropped: Cortex merged two summaries of
// the same template into one memory of mixed numbers, which recall did not find (measured on the live
// Cortex 2026-10-14). Pure, so the register and the tests share it; the push itself (register.tsx)
// lives outside any hook that ends the session.

import type { TurnRecord } from '../types'
import { BRIEF_LINE_CAP, BRIEF_SESSIONS, composeBrief, mechanicalShare, windowOf } from './brief'
import { delegationStats } from './delegations'
import { sessionModels } from './models'

// The aggregate's text over the finished sessions' records (the newest BRIEF_SESSIONS of them), or
// null when nothing is measured. composeBrief's header is replaced, its lines kept.
export const aggregateSummary = (records: readonly TurnRecord[], now: number): string | null => {
  const w = windowOf(records, BRIEF_SESSIONS)
  const body = composeBrief({ delegations: delegationStats(w.records), models: sessionModels(w.records), mechanical: mechanicalShare(w.records) })
  if (body === null) return null
  const header = `Self-calibration (zetetic-insights, last ${w.sessions} finished sessions, as of ${new Date(now).toISOString().slice(0, 10)}):`

  return [header, ...body.split('\n').slice(1)].map((l) => l.slice(0, BRIEF_LINE_CAP)).join('\n')
}

// Cortex's remember result as the plugin receives it: the handler's dict as structuredContent (the
// tool declares an outputSchema: Cortex mcp_server/handlers/remember_schema.py), or the same JSON in
// a text block.
export type RememberReply = { content: readonly unknown[]; isError: boolean; structuredContent?: unknown }
// head: the aggregate is now this memory. merged: Cortex folded the text into ANOTHER memory (not
// ours). rejected: the write gate refused it, so NOTHING is stored and no session is covered.
// cleared: our head is gone or was superseded by a memory we did not create (foreignId, named only,
// never adopted). failed: nothing changed, retried at the next start.
export type RememberOutcome =
  | { kind: 'head'; memoryId: number }
  | { kind: 'merged'; memoryId: number | null }
  | { kind: 'rejected'; reason: string }
  | { kind: 'cleared'; reason: string; foreignId: number | null }
  | { kind: 'failed'; failure: string }

const textOf = (content: readonly unknown[]): string =>
  content.map((b) => (typeof b === 'object' && b !== null && 'text' in b ? String((b as { text: unknown }).text) : '')).join(' ').trim()

const resultOf = (r: RememberReply): Record<string, unknown> | null => {
  if (typeof r.structuredContent === 'object' && r.structuredContent !== null) return r.structuredContent as Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(textOf(r.content))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const idOf = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : null)

// The reply shapes are Cortex's own: stored/superseded/merged (remember_response.py 69-123), the
// supersede rejections (remember_helpers.py 821-873), the write gate's rejection (write_gate.py 145-166).
export const rememberOutcome = (r: RememberReply): RememberOutcome => {
  if (r.isError) return { kind: 'failed', failure: textOf(r.content) || 'remember returned an error' }
  const o = resultOf(r)
  if (o === null) return { kind: 'failed', failure: 'remember reply not parsed' }
  const id = idOf(o.memory_id)
  if (o.stored === true && o.action === 'merged') return { kind: 'merged', memoryId: id }
  if (o.stored === true) return id === null ? { kind: 'failed', failure: 'remember stored without a memory_id' } : { kind: 'head', memoryId: id }
  const reason = String(o.reason ?? o.action ?? 'not stored')
  if (reason === 'supersede_target_not_found' || reason === 'invalid_supersedes_id') return { kind: 'cleared', reason, foreignId: null }
  if (reason === 'supersede_target_already_superseded') return { kind: 'cleared', reason, foreignId: idOf(o.current_superseded_by_id) }
  if (o.action === 'superseded_conflict') return { kind: 'cleared', reason, foreignId: idOf(o.current_head_id) }
  return { kind: 'rejected', reason }
}
