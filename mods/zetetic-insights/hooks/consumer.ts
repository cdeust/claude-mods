// What the insights hand to Cortex: one self-contained memory per finished session, built from the
// same facts and the same functions as the brief, over that session's ledger records only. Pure, so
// the register and the tests share it; the push itself (register.tsx) lives outside any hook that
// ends the session.

import type { TurnRecord } from '../types'
import { BRIEF_LINE_CAP, composeBrief, mechanicalShare } from './brief'
import { delegationStats } from './delegations'
import { sessionModels } from './models'

export const SUMMARY_ID_CHARS = 8 // source: own choice, the leading characters of a session id; enough to tell sessions apart in a memory text

// The text of one session's memory, or null when the session has no main step (nothing measured).
// Header, then the brief's own lines (mechanical share, delegations, latest flagged, steps by model)
// computed over this session's records alone: composeBrief's header is replaced, its lines kept.
export const sessionSummary = (records: readonly TurnRecord[], session: string): string | null => {
  const own = records.filter((r) => r.session === session)
  if (!own.some((r) => r.main.some((run) => run.steps > 0))) return null
  const last = Math.max(...own.map((r) => r.at))
  const body = composeBrief({ delegations: delegationStats(own), models: sessionModels(own), mechanical: mechanicalShare(own) })
  if (body === null) return null
  const header = `Self-calibration of session ${session.slice(0, SUMMARY_ID_CHARS)} (${new Date(last).toISOString().slice(0, 10)}), zetetic-insights ledger:`

  return [header, ...body.split('\n').slice(1)].map((l) => l.slice(0, BRIEF_LINE_CAP)).join('\n')
}

// Cortex's remember result as the plugin receives it: the handler's dict as structuredContent (the
// tool declares an outputSchema: Cortex mcp_server/handlers/remember_schema.py:16-133, attached by
// _tool_meta.py:87-102), or the same JSON in a text block. memory_id is an integer present when
// stored is true (remember_schema.py:27-33, remember_response.py:78).
export type RememberReply = { content: readonly unknown[]; isError: boolean; structuredContent?: unknown }
export type RememberOutcome = { ok: true; memoryId?: number } | { ok: false; failure: string; rebase?: number | null }

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

const idOf = (v: unknown): number | undefined => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : undefined)

// Delivered: no error, and either stored (its memory_id kept when it parses) or judged redundant by
// the write gate (action rejected, a gate reason: Cortex decided, re-sending would not change that).
// A supersede that cannot land is a failure, with the id to supersede next time: none when the
// target is gone, the version that replaced it when already superseded or raced (remember_helpers.py
// 851-873 and 818-830).
export const rememberOutcome = (r: RememberReply): RememberOutcome => {
  if (r.isError) return { ok: false, failure: textOf(r.content) || 'remember returned an error' }
  const o = resultOf(r)
  if (o === null || o.stored === true) {
    const memoryId = idOf(o?.memory_id)
    return memoryId === undefined ? { ok: true } : { ok: true, memoryId }
  }
  const reason = String(o.reason ?? o.action ?? 'not stored')
  if (reason === 'supersede_target_not_found' || reason === 'invalid_supersedes_id') return { ok: false, failure: reason, rebase: null }
  if (reason === 'supersede_target_already_superseded') return { ok: false, failure: reason, rebase: idOf(o.current_superseded_by_id) ?? null }
  if (o.action === 'superseded_conflict') return { ok: false, failure: reason, rebase: idOf(o.current_head_id) ?? null }
  return { ok: true }
}
