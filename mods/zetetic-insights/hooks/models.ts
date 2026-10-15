// Who did the steps: each ledger turn's main steps and its agents' steps, counted under one model
// family, per session. The one counting procedure the panel shows; pure, so the register and the
// tests share it.

import type { ModelFamily, SessionModels, TurnRecord } from '../types'
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

// Each session's steps by family, the newest MODEL_SESSIONS working sessions by their latest record, oldest
// first, probes (hooks/probes.ts) flagged and not counted among them. Every main run and every agent step is added to exactly one family, so a session's family
// steps sum to its main steps plus its agent steps. A main turn with no mainModel (a record kept
// before it was) is unknown. The sums are O(records); the sessions are sorted by their latest turn.
export const sessionModels = (records: readonly TurnRecord[], probes: ReadonlyMap<string, ProbeInfo> = new Map()): SessionModels[] => {
  const by = new Map<string, { at: number; steps: Map<ModelFamily, number> }>()
  const add = (session: string, at: number, family: ModelFamily, steps: number) => {
    const row = by.get(session) ?? { at, steps: new Map<ModelFamily, number>() }
    row.at = Math.max(row.at, at)
    row.steps.set(family, (row.steps.get(family) ?? 0) + steps)
    by.set(session, row)
  }
  for (const r of records) {
    const main = familyOf(r.mainModel ?? '')
    for (const run of r.main) add(r.session, r.at, main, run.steps)
    for (const a of r.agents) add(r.session, r.at, familyOf(a.model), a.steps)
  }
  const rows: SessionModels[] = [...by.entries()]
    .map(([session, row]) => ({
      session,
      at: row.at,
      steps: ORDER.flatMap((family) => {
        const steps = row.steps.get(family) ?? 0
        return steps > 0 ? [{ family, steps }] : []
      }),
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
