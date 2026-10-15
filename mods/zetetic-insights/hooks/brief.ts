// The self-calibration text the model reads at the end of its system prompt: its own costly habits,
// as the ledger measured them. Measured facts only, no advice; the model draws its own conclusions.
// Pure, so the register and the tests share it. The register computes it once at session start and
// freezes it: a system prompt that changed mid-session would void its prompt cache on every request.

import type { DelegationStats, FrictionRow, MechanicalShare, ModelFamily, SessionModels, TurnRecord } from '../types'
import { delegationStats } from './delegations'
import { type Friction, recurringOver } from './friction'
import { familyOf, sessionModels } from './models'
import { type ProbeInfo, withoutProbes } from './probes'

export const BRIEF_SESSIONS = 10 // source: own choice, the last sessions the mechanical share is measured over; recent habits, enough turns for a share
export const BRIEF_MAX_LINES = 6 // source: own choice, a system-prompt section the model reads on every request stays short
export const BRIEF_LINE_CAP = 200 // source: own choice, characters kept of a line; a long agent type or flag list must not grow the prompt

// The one predicate of "mechanical work" is zetetic-autopilot's (phases.ts isFileReadStep): a step whose
// every tool call is Read, Grep or Glob. The autopilot counts it per run (`reads`); this file only
// sums the counts of main's steps on opus or fable. Not the analysis phase: that phase also holds
// delegations, Cortex recalls, skills and read-only Bash.
const HEAVY: readonly ModelFamily[] = ['opus', 'fable'] // source: delegations.ts overkill, the families a cheaper model could replace
const isHeavy = (r: TurnRecord): boolean => HEAVY.includes(familyOf(r.mainModel ?? ''))

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

// Main's file-read steps on opus or fable over the records' sessions (the newest `sessions` of them),
// against the steps of the same records that were measured. A run without `reads` (recorded before it
// was counted) is unmeasured: its steps are in `unmeasured`, never in heavySteps as zero reads.
// heavySteps + unmeasured = all of main's steps on those models.
export const mechanicalShare = (records: readonly TurnRecord[], sessions: number = BRIEF_SESSIONS): MechanicalShare => {
  const window = windowOf(records, sessions)
  let heavySteps = 0
  let heavyReads = 0
  let unmeasured = 0
  for (const r of window.records) {
    if (!isHeavy(r)) continue
    for (const run of r.main) {
      if (run.reads === undefined) unmeasured += run.steps
      else {
        heavySteps += run.steps
        heavyReads += run.reads
      }
    }
  }
  return { sessions: window.sessions, heavyReads, heavySteps, unmeasured, share: heavySteps === 0 ? null : heavyReads / heavySteps }
}

// The delegations the outcome events judged, only when some are (merged with an approving review, reverted, closed): "; judged by events: 2 achieved, 1 not".
const judgedText = (d: DelegationStats): string =>
  d.outcomes.achieved + d.outcomes['not-achieved'] === 0 ? '' : `; judged by events: ${d.outcomes.achieved} achieved, ${d.outcomes['not-achieved']} not`

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
// session with a step, no judged delegation, no share and no recurring friction. The friction line is
// the last one: with the header and the four measures above it the brief is exactly BRIEF_MAX_LINES,
// and were a line ever added, this is the one that yields (the slice cuts from the end).
export const composeBrief = (o: { delegations: DelegationStats; models: readonly SessionModels[]; mechanical: MechanicalShare; frictions?: readonly FrictionRow[] }): string | null => {
  const { delegations: d, mechanical: m } = o
  const top = o.frictions?.[0]
  const steps = stepsByModel(o.models.filter((m) => !m.probe))
  if (steps.total === 0 && d.total === 0 && m.share === null && top === undefined) return null
  const lines = [`Self-calibration (zetetic-insights ledger, last ${m.sessions} sessions). Measured, not prescribed:`]
  if (m.share !== null)
    lines.push(
      `- main thread on opus/fable: ${Math.round(100 * m.share)}% of its measured steps only read files (Read, Grep, Glob); those reads need no heavy model.${m.unmeasured > 0 ? ` (${m.unmeasured} older steps unmeasured)` : ''}`,
    )
  if (d.total > 0)
    lines.push(
      `- delegations: ${d.total} (${d.designed} with a DESIGN block); overkill ${d.flags.overkill}, underpowered ${d.flags.underpowered}, undesigned ${d.flags.undesigned}, rerouted ${d.flags.rerouted}${judgedText(d)}.`,
    )
  const last = d.recent[d.recent.length - 1]
  if (last !== undefined)
    lines.push(`- latest flagged: ${last.type} on ${last.model} (${last.effort ?? 'effort unset'}), ${last.steps} steps, ${last.errors} failed: ${last.flags.join(', ')}.`)
  if (steps.line !== null) lines.push(steps.line)
  if (top !== undefined) lines.push(`- recurring friction: ${top.signature} (${top.kind}, ${top.sessions} sessions, ${top.count} times)`)

  return lines
    .slice(0, BRIEF_MAX_LINES)
    .map((l) => l.slice(0, BRIEF_LINE_CAP))
    .join('\n')
}

// The brief of a ledger: every line is computed from the same BRIEF_SESSIONS newest sessions, so the
// header's count is true of all of them, the frictions' too (`frictions`: what was measured, by session).
// The panel's own delegations and models stay on the whole ledger.
export const briefOf = (records: readonly TurnRecord[], frictions: ReadonlyMap<string, readonly Friction[]> = new Map(), probes: ReadonlyMap<string, ProbeInfo> = new Map()): string | null => {
  // Probe sessions (hooks/probes.ts) are not the model's habits: they take no slot of the window.
  const w = windowOf(withoutProbes(records, probes))

  return composeBrief({
    delegations: delegationStats(w.records),
    models: sessionModels(w.records, probes),
    mechanical: mechanicalShare(w.records),
    frictions: recurringOver(frictions, windowSessions(w.records)),
  })
}

// The sessions of a window's records.
export const windowSessions = (records: readonly TurnRecord[]): Set<string> => new Set(records.map((r) => r.session))
