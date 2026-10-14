// Pure side of the learning loop: the turn records the ledger keeps, what they say per phase and
// effort, the session outcomes /insights wrote, the goals' status, and the bounded change of one
// phase's effort the evidence supports.

import type { AgentRecord, AgentStat, Calibration, Effort, Phase, PhaseStat, Proposal, TurnRecord } from '../types'

export const LEDGER_KEY = 'turns'
export const LEDGER_CAP = 3000 // source: own choice, the turns the rates are read from
// source: claude-code types, `$.store.set` "rejects ... a store over 4 MiB of JSON text in all"
// (every key of the mod's store). The ledger keeps 3 MiB of it as the file writes it, the rest is
// margin.
export const LEDGER_BYTES = 3 * 1024 * 1024
// source: own choice, the agents one record keeps (~200 bytes each); the rest are counted.
export const MAX_AGENTS = 50
export const FACET_SESSIONS_CAP = 80 // source: own choice, the facets read at start are the last sessions'

// source: Claude Code 2.1.299 binary: `/insights` writes `<config dir>/usage-data/facets/<session id>.json`
// with `"outcome": "fully_achieved|mostly_achieved|partially_achieved|not_achieved|unclear_from_transcript"`.
export const FACETS_DIR = '~/.claude/usage-data/facets'
// The file the autopilot reads (its hooks/calibration.ts names the same path).
export const CALIBRATION_PATH = '~/.claude/zetetic-insights/calibration.json'
// source: zetetic-loop verify-goal skill: a goal file's last `status:` line is its state.
export const GOALS_DIR = '.zetetic/goals'

// source: own choices, stated so they can be argued with. A phase needs this many main steps at
// one effort before its rate means anything; a raise needs this share of steps with a failed tool
// call; a lowering needs almost none, and session outcomes that say the work was achieved.
export const MIN_STEPS = 40
// source: own choice, undoing a phase's last move needs three times the evidence that made it,
// so enforce cannot swing a phase back and forth on runs that sit near both thresholds.
export const REVERSAL_STEPS = 3 * MIN_STEPS
export const RAISE_RATE = 0.25
export const LOWER_RATE = 0.05
export const MIN_JUDGED_SESSIONS = 5
export const ACHIEVED_SHARE = 0.8

// source: zetetic-autopilot policy.ts effortFor: without calibration the tool loop runs at medium.
export const LOOP_DEFAULT: Effort = 'medium'
const LADDER: readonly Effort[] = ['low', 'medium', 'high']

export type Outcome = 'achieved' | 'not-achieved' | 'unclear'

export const outcomeOf = (facetJson: string): Outcome => {
  let raw: unknown
  try {
    raw = JSON.parse(facetJson)
  } catch (error) {
    throw new Error(`facet is not valid JSON (${error instanceof Error ? error.message : String(error)})`.slice(0, 120))
  }
  const o = (raw as { outcome?: unknown } | null)?.outcome
  if (o === 'fully_achieved' || o === 'mostly_achieved') return 'achieved'
  if (o === 'partially_achieved' || o === 'not_achieved') return 'not-achieved'
  return 'unclear'
}

export const goalStatus = (md: string): string => {
  const lines = md.split('\n').filter((l) => /^status:\s*\S/.test(l))
  return (lines[lines.length - 1] ?? 'status: none').replace(/^status:\s*/, '').trim()
}

// UTF-8 length of a JSON text, what the store measures; a lone surrogate counts as 3 bytes, the
// replacement character it is written as.
export const utf8Bytes = (text: string): number => {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

// A record's bytes as the store file holds it: the file is JSON indented by two spaces (read from
// ~/.claude/plugins/store/zetetic-insights_*.json, 2026-10-14: 865 bytes against 474 compact), a
// record sitting two levels deep under `{"turns": [...]}`. Whether the store's 4 MiB counts that
// text or the compact one, this is the larger, so the cap holds under both.
export const recordBytes = (r: TurnRecord): number => {
  const text = JSON.stringify(r, null, 2)
  let lines = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++
  return utf8Bytes(text) + 4 * lines + 2 // the indent of each line, then ",\n"
}

// The newest records that fit both caps, oldest dropped first. Each record is measured once:
// O(n) in the records, whatever the ledger loaded from the store weighed.
export const trimmed = (records: readonly TurnRecord[], maxBytes = LEDGER_BYTES, maxCount = LEDGER_CAP): TurnRecord[] => {
  const sizes = records.map(recordBytes)
  let total = sizes.reduce((a, b) => a + b, 1)
  let from = Math.max(0, records.length - maxCount)
  for (let i = 0; i < from; i++) total -= sizes[i]!
  while (from < records.length && total > maxBytes) total -= sizes[from++]!
  return records.slice(from)
}

// One finished agent added to a turn's list, past MAX_AGENTS counted instead of kept.
export const withAgent = (
  list: { agents: AgentRecord[]; dropped: number },
  agent: AgentRecord,
): { agents: AgentRecord[]; dropped: number } =>
  list.agents.length < MAX_AGENTS ? { agents: [...list.agents, agent], dropped: list.dropped } : { agents: list.agents, dropped: list.dropped + 1 }

const statKey = (phase: string, effort: string) => `${phase}|${effort}`

// Main's runs per phase and effort, with the sessions they came from and those sessions' outcomes.
// A phase moved by the calibration counts only the runs recorded after its last move: the runs
// before it were made at the effort it left.
export const phaseStats = (
  records: readonly TurnRecord[],
  outcomes: ReadonlyMap<string, Outcome>,
  changes: Calibration['changes'] = {},
): PhaseStat[] => {
  const by = new Map<string, PhaseStat & { sessionSet: Set<string> }>()
  for (const r of records)
    for (const run of r.main) {
      if (r.at <= (changes[run.phase]?.at ?? Number.NEGATIVE_INFINITY)) continue
      const effort = run.effort ?? 'default'
      const k = statKey(run.phase, effort)
      const row = by.get(k) ?? { phase: run.phase, effort, steps: 0, errors: 0, sessions: 0, judged: 0, achieved: 0, sessionSet: new Set<string>() }
      row.steps += run.steps
      row.errors += run.errors
      row.sessionSet.add(r.session)
      by.set(k, row)
    }
  return [...by.values()]
    .map(({ sessionSet, ...row }) => {
      const judged = [...sessionSet].map((s) => outcomes.get(s)).filter((o) => o === 'achieved' || o === 'not-achieved')
      return { ...row, sessions: sessionSet.size, judged: judged.length, achieved: judged.filter((o) => o === 'achieved').length }
    })
    .sort((a, b) => a.phase.localeCompare(b.phase) || a.effort.localeCompare(b.effort))
}

export const agentStats = (records: readonly TurnRecord[]): AgentStat[] => {
  const by = new Map<string, AgentStat>()
  for (const r of records)
    for (const a of r.agents) {
      const row = by.get(a.type) ?? { type: a.type, runs: 0, steps: 0, errors: 0, models: [] }
      by.set(a.type, {
        ...row,
        runs: row.runs + 1,
        steps: row.steps + a.steps,
        errors: row.errors + a.errors,
        models: row.models.includes(a.model) ? row.models : [...row.models, a.model],
      })
    }
  return [...by.values()].sort((a, b) => b.runs - a.runs)
}

const notch = (effort: Effort, by: 1 | -1): Effort | undefined => LADDER[LADDER.indexOf(effort) + by]

// One proposal per phase at most: one notch, from the effort the loop runs that phase at now, read
// from the steps that ran at that effort. The rung is a ceiling (autopilot policy.ts effortFor): a
// raise lifts only the turns whose graded base is at or above the new rung, a routine turn's loop
// stays at its base. Undoing the phase's last move needs REVERSAL_STEPS.
export const proposals = (stats: readonly PhaseStat[], calibration: Calibration): Proposal[] => {
  const out: Proposal[] = []
  for (const phase of new Set(stats.map((s) => s.phase as Phase))) {
    const now = calibration.phases[phase] ?? LOOP_DEFAULT
    const row = stats.find((s) => s.phase === phase && s.effort === now)
    if (row === undefined || row.steps < MIN_STEPS) continue
    const rate = row.errors / row.steps
    const evidence = `${row.errors} failed calls in ${row.steps} steps at ${now} over ${row.sessions} sessions`
    const isEnough = (to: Effort) => calibration.changes[phase]?.from !== to || row.steps >= REVERSAL_STEPS
    const up = notch(now, 1)
    if (rate >= RAISE_RATE && up !== undefined) {
      if (isEnough(up)) out.push({ phase, from: now, to: up, evidence })
      continue
    }
    const down = notch(now, -1)
    const isAchieved = row.judged >= MIN_JUDGED_SESSIONS && row.achieved / row.judged >= ACHIEVED_SHARE
    if (rate <= LOWER_RATE && isAchieved && down !== undefined && isEnough(down))
      out.push({ phase, from: now, to: down, evidence: `${evidence}; ${row.achieved}/${row.judged} sessions achieved (/insights)` })
  }
  return out
}

// Phases with enough steps, none of them at the rung the calibration reads: no proposal can come
// from them (the autopilot observes, or the turns' grades keep the loop elsewhere). Named, so an
// empty proposal list is not read as "the evidence supports the rung".
export const offRung = (stats: readonly PhaseStat[], calibration: Calibration): { phase: string; now: Effort; ran: string[] }[] =>
  [...new Set(stats.map((s) => s.phase as Phase))].flatMap((phase) => {
    const now = calibration.phases[phase] ?? LOOP_DEFAULT
    const rows = stats.filter((s) => s.phase === phase)
    const atNow = rows.find((s) => s.effort === now)?.steps ?? 0
    const total = rows.reduce((n, s) => n + s.steps, 0)
    return atNow < MIN_STEPS && total >= MIN_STEPS ? [{ phase, now, ran: rows.map((s) => `${s.effort} ${s.steps}`) }] : []
  })

export const emptyCalibration = (): Calibration => ({ version: 1, phases: {}, evidence: {}, changes: {}, updatedAt: null })

export const parseCalibration = (text: string): Calibration => {
  const raw = JSON.parse(text) as Partial<Calibration>
  if (raw.version !== 1 || typeof raw.phases !== 'object' || raw.phases === null)
    throw new Error('calibration.json is not version 1 with a phases object')
  return { version: 1, phases: raw.phases, evidence: raw.evidence ?? {}, changes: raw.changes ?? {}, updatedAt: raw.updatedAt ?? null }
}

export const applied = (c: Calibration, ps: readonly Proposal[], at: number): Calibration => ({
  version: 1,
  phases: { ...c.phases, ...Object.fromEntries(ps.map((p) => [p.phase, p.to])) },
  evidence: { ...c.evidence, ...Object.fromEntries(ps.map((p) => [p.phase, `${p.from} → ${p.to}: ${p.evidence}`])) },
  changes: { ...c.changes, ...Object.fromEntries(ps.map((p) => [p.phase, { at, from: p.from, to: p.to }])) },
  updatedAt: at,
})

// The advisor against the grades: how often an analysis or critical turn consulted it before
// writing, and how often a routine one called it at all.
export const advisorStats = (records: readonly TurnRecord[]) => {
  const heavy = records.filter((r) => r.taskClass === 'analysis' || r.taskClass === 'critical')
  const light = records.filter((r) => r.taskClass === 'routine' || r.taskClass === 'planned')
  return {
    heavyTurns: heavy.length,
    heavyBeforeWrite: heavy.filter((r) => r.advisor.beforeWrite > 0).length,
    heavyAtCompletion: heavy.filter((r) => r.advisor.atCompletion > 0).length,
    lightTurns: light.length,
    lightWithAdvisor: light.filter((r) => r.advisor.calls > 0).length,
  }
}
