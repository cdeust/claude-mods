// The self-calibration text the model reads at the end of its system prompt: its own costly habits,
// as the ledger measured them. Measured facts only, no advice; the model draws its own conclusions.
// Pure, so the register and the tests share it. The register computes it once at session start and
// freezes it: a system prompt that changed mid-session would void its prompt cache on every request.

import type { DelegationStats, MechanicalShare, ModelFamily, SessionModels, TurnRecord } from '../types'
import { delegationStats } from './delegations'
import { familyOf, sessionModels } from './models'

export const BRIEF_SESSIONS = 10 // source: own choice, the last sessions the mechanical share is measured over; recent habits, enough turns for a share
export const BRIEF_MAX_LINES = 6 // source: own choice, a system-prompt section the model reads on every request stays short
export const BRIEF_LINE_CAP = 200 // source: own choice, characters kept of a line; a long agent type or flag list must not grow the prompt

// Why 'analysis' measures mechanical work: zetetic-autopilot's `toolPhase` (hooks/phases.ts) maps the
// reading tools (READING_TOOLS: Read, Grep, Glob, WebFetch, WebSearch, LSP, ToolSearch) to 'analysis'.
// The one predicate of "mechanical work": a main step in the analysis phase on opus or fable.
const HEAVY: readonly ModelFamily[] = ['opus', 'fable'] // source: delegations.ts overkill, the families a cheaper model could replace
const isHeavy = (r: TurnRecord): boolean => HEAVY.includes(familyOf(r.mainModel ?? ''))
const isMechanical = (phase: string): boolean => phase === 'analysis'

// The order the families are listed in (models.ts ORDER).
const ORDER: readonly ModelFamily[] = ['haiku', 'sonnet', 'opus', 'fable', 'other', 'unknown'] // source: models.ts ORDER

// The one window of the brief: the records of the newest `sessions` sessions, by each one's newest
// record, in ledger order. A session whose oldest turns the ledger trimmed counts what it still holds.
export const windowOf = (records: readonly TurnRecord[], sessions: number = BRIEF_SESSIONS): { records: TurnRecord[]; sessions: number } => {
  const newest = new Map<string, number>()
  for (const r of records) newest.set(r.session, Math.max(newest.get(r.session) ?? r.at, r.at))
  const keep = new Set(
    [...newest.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(-sessions)
      .map(([session]) => session),
  )
  return { records: records.filter((r) => keep.has(r.session)), sessions: keep.size }
}

// Main's steps on opus or fable over the records' sessions (the newest `sessions` of them), and the
// part of them in the analysis phase.
export const mechanicalShare = (records: readonly TurnRecord[], sessions: number = BRIEF_SESSIONS): MechanicalShare => {
  const window = windowOf(records, sessions)
  let heavySteps = 0
  let heavyAnalysis = 0
  for (const r of window.records) {
    if (!isHeavy(r)) continue
    for (const run of r.main) {
      heavySteps += run.steps
      if (isMechanical(run.phase)) heavyAnalysis += run.steps
    }
  }
  return { sessions: window.sessions, heavyAnalysis, heavySteps, share: heavySteps === 0 ? null : heavyAnalysis / heavySteps }
}

const percent = (part: number, whole: number): string => {
  const p = Math.round((100 * part) / whole)
  return p === 0 ? '<1%' : `${p}%`
}

const stepsByModel = (models: readonly SessionModels[]): { total: number; line: string | null } => {
  const by = new Map<ModelFamily, number>()
  for (const s of models) for (const m of s.steps) by.set(m.family, (by.get(m.family) ?? 0) + m.steps)
  const total = [...by.values()].reduce((n, v) => n + v, 0)
  if (total === 0) return { total, line: null }
  const parts = ORDER.flatMap((f) => ((by.get(f) ?? 0) > 0 ? [`${f} ${percent(by.get(f) ?? 0, total)}`] : []))
  return { total, line: `- steps by model: ${parts.join(', ')}.` }
}

// At most BRIEF_MAX_LINES lines of BRIEF_LINE_CAP characters; null when nothing is measured: no
// session with a step, no judged delegation and no share.
export const composeBrief = (o: { delegations: DelegationStats; models: readonly SessionModels[]; mechanical: MechanicalShare }): string | null => {
  const { delegations: d, mechanical: m } = o
  const steps = stepsByModel(o.models)
  if (steps.total === 0 && d.total === 0 && m.share === null) return null
  const lines = [`Self-calibration (zetetic-insights ledger, last ${m.sessions} sessions). Measured, not prescribed:`]
  if (m.share !== null)
    lines.push(`- main thread on opus/fable: ${Math.round(100 * m.share)}% of its steps were reading (analysis); a haiku or sonnet delegation could have done them.`)
  if (d.total > 0)
    lines.push(
      `- delegations: ${d.total} (${d.designed} with a DESIGN block); overkill ${d.flags.overkill}, underpowered ${d.flags.underpowered}, undesigned ${d.flags.undesigned}, rerouted ${d.flags.rerouted}.`,
    )
  const last = d.recent[d.recent.length - 1]
  if (last !== undefined)
    lines.push(`- latest flagged: ${last.type} on ${last.model} (${last.effort ?? 'effort unset'}), ${last.steps} steps, ${last.errors} failed: ${last.flags.join(', ')}.`)
  if (steps.line !== null) lines.push(steps.line)

  return lines
    .slice(0, BRIEF_MAX_LINES)
    .map((l) => l.slice(0, BRIEF_LINE_CAP))
    .join('\n')
}

// The brief of a ledger: every line is computed from the same BRIEF_SESSIONS newest sessions, so the
// header's count is true of all of them. The panel's own delegations and models stay on the whole ledger.
export const briefOf = (records: readonly TurnRecord[]): string | null => {
  const w = windowOf(records)

  return composeBrief({ delegations: delegationStats(w.records), models: sessionModels(w.records), mechanical: mechanicalShare(w.records) })
}
