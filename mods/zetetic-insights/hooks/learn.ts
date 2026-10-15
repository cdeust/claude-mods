// Pure side of the learning loop: the turn records the ledger keeps, what they say per phase and
// effort, the session outcomes /insights wrote, the goals' status, and the bounded change of one
// phase's effort the evidence supports.

import type { AgentRecord, AgentStat, Calibration, Effort, Proposal, TurnRecord } from '../types'

export const LEDGER_CAP = 3000 // source: own choice, the turns the rates are read from
// source: claude-code types, `$.store.set` "rejects ... a store over 4 MiB of JSON text in all"
// (every key of the mod's store). The ledger, all turns:* keys together (ledger.ts), keeps 3 MiB of
// it as the file writes it, the rest is margin.
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

// source: zetetic-autopilot policy.ts effortFor: without calibration the tool loop runs at medium.
export const LOOP_DEFAULT: Effort = 'medium'
export const LADDER: readonly Effort[] = ['low', 'medium', 'high']

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

export const emptyCalibration = (): Calibration => ({ version: 1, phases: {}, evidence: {}, changes: {}, moves: [], updatedAt: null })

export const parseCalibration = (text: string): Calibration => {
  const raw = JSON.parse(text) as Partial<Calibration>
  if (raw.version !== 1 || typeof raw.phases !== 'object' || raw.phases === null)
    throw new Error('calibration.json is not version 1 with a phases object')
  return { version: 1, phases: raw.phases, evidence: raw.evidence ?? {}, changes: raw.changes ?? {}, moves: Array.isArray(raw.moves) ? raw.moves : [], updatedAt: raw.updatedAt ?? null }
}

export const applied = (c: Calibration, ps: readonly Proposal[], at: number, moves: Calibration['moves'] = c.moves): Calibration => ({
  version: 1,
  phases: { ...c.phases, ...Object.fromEntries(ps.map((p) => [p.phase, p.to])) },
  evidence: { ...c.evidence, ...Object.fromEntries(ps.map((p) => [p.phase, `${p.from} → ${p.to}: ${p.evidence}`])) },
  changes: { ...c.changes, ...Object.fromEntries(ps.map((p) => [p.phase, { at, from: p.from, to: p.to }])) },
  moves,
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
