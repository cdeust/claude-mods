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

// The sessions still to hand over, oldest first by their newest record: not the current one (it is
// still being measured), not one already handed over, and only those with a summary.
// A session the ledger trimmed away (by bytes) before it was handed over is not in `records`, so it
// is never handed over: the handoff cannot invent what the ledger no longer holds.
export const pendingSessions = (records: readonly TurnRecord[], current: string, handed: ReadonlySet<string>): string[] => {
  const newest = new Map<string, number>()
  for (const r of records) newest.set(r.session, Math.max(newest.get(r.session) ?? r.at, r.at))

  return [...newest.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([session]) => session)
    .filter((s) => s !== current && !handed.has(s) && sessionSummary(records, s) !== null)
}
