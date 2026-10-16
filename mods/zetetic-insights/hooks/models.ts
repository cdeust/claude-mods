// Who did the steps: each ledger turn's main steps and its agents' steps, counted under one model
// family, per session. The one counting procedure the panel shows; pure, so the register and the
// tests share it.

import type { ModelFamily, ModelSteps, SessionModels, TurnRecord } from '../types'
import type { ProbeInfo } from './probes'

export const MODEL_SESSIONS = 12 // source: own choice, the sessions the panel shows, the newest last

// The families a model id is matched against, in this order: a name carrying two of them is the first.
const MATCH: readonly Exclude<ModelFamily, 'other' | 'unknown'>[] = ['fable', 'opus', 'sonnet', 'haiku']
// The order the steps are listed in.
const ORDER: readonly ModelFamily[] = ['haiku', 'sonnet', 'opus', 'fable', 'other', 'unknown']

// A model id reduced to its family. Empty (or missing, passed as '') is unknown; a name matching
// no family is other.
export const familyOf = (model: string): ModelFamily => {
  if (model === '') return 'unknown'
  const name = model.toLowerCase()
  for (const family of MATCH) if (name.includes(family)) return family
  return 'other'
}

// Steps appended in the order they ran, a run of the same family as the last one added to it.
const appendRun = (seq: ModelSteps[], family: ModelFamily, steps: number): void => {
  if (steps <= 0) return
  const last = seq[seq.length - 1]
  if (last?.family === family) last.steps += steps
  else seq.push({ family, steps })
}

// Each session's steps by family, the newest MODEL_SESSIONS working sessions by their latest record, oldest
// first, probes (hooks/probes.ts) flagged and not counted among them. Every main run and every agent step is added to exactly one family, so a session's family
// steps sum to its main steps plus its agent steps. A main turn with no mainModel (a record kept
// before it was) is unknown. The sums are O(records); the sessions are sorted by their latest turn.
// `sequence` holds the same steps in the order they ran: the turns by `at`, and inside a turn main's
// runs and its agents by when each began (`since`, kept from 0.11.0), or main's runs then its agents
// in the order kept for a record without it. Its families sum to `steps`.
export const sessionModels = (records: readonly TurnRecord[], probes: ReadonlyMap<string, ProbeInfo> = new Map()): SessionModels[] => {
  const by = new Map<string, { at: number; steps: Map<ModelFamily, number>; sequence: ModelSteps[] }>()
  const add = (session: string, at: number, family: ModelFamily, steps: number) => {
    const row = by.get(session) ?? { at, steps: new Map<ModelFamily, number>(), sequence: [] }
    row.at = Math.max(row.at, at)
    row.steps.set(family, (row.steps.get(family) ?? 0) + steps)
    appendRun(row.sequence, family, steps)
    by.set(session, row)
  }
  for (const r of [...records].sort((a, b) => a.at - b.at)) {
    const main = familyOf(r.mainModel ?? '')
    const parts = [...r.main.map((run) => ({ since: run.since, family: main, steps: run.steps })), ...r.agents.map((a) => ({ since: a.since, family: familyOf(a.model), steps: a.steps }))]
    // A record that times every part is laid out by time (an agent between main's steps before and
    // after it); one that does not keeps main's runs then its agents. Sort is stable.
    const timed = parts.every((p) => p.since !== undefined) ? [...parts].sort((a, b) => a.since! - b.since!) : parts
    for (const p of timed) add(r.session, r.at, p.family, p.steps)
  }
  const rows: SessionModels[] = [...by.entries()]
    .map(([session, row]) => ({
      session,
      at: row.at,
      steps: ORDER.flatMap((family) => {
        const steps = row.steps.get(family) ?? 0
        return steps > 0 ? [{ family, steps }] : []
      }),
      sequence: row.sequence,
      probe: probes.get(session)?.probe === true,
      probeReason: probes.get(session)?.reason ?? null,
    }))
    .sort((a, b) => a.at - b.at)
  // The newest MODEL_SESSIONS working sessions, and the probes newer than the oldest of them: flagged,
  // never filling a slot of the chart.
  const work = rows.filter((r) => !r.probe).slice(-MODEL_SESSIONS)
  const from = work[0]?.at ?? Number.POSITIVE_INFINITY
  return rows.filter((r) => (r.probe ? r.at >= from : work.includes(r)))
}
