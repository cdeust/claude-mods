// Each spawn's record: in $.state for the viewers and in $.store (`spawns:<start>:<session>`, spawns.ts) for whoever
// reads it after the session, so an outcome is attributed to the model that ran and the rule that chose it.
import type { EngineInterface } from 'claude-code'

import type { SpawnRoute } from '../types'
import type { Steer } from './dispatch'
import { type Decided, carried } from './effort'
import type { Routed } from './route'
import { ROUTES_PER_SESSION, spawnsKey, staleSpawnKeys } from './spawns'

// A failed store read or write, named as a row by the caller (register.tsx `note`).
export type Note = (subject: string, reason: string) => Promise<void>
type Change = (kept: SpawnRoute[]) => SpawnRoute[]

export type RouteFields = Omit<SpawnRoute, 'at' | 'agentId' | 'type' | 'ran'>

// `effortApplied` as the record is written: the effort was decided under enforce AND a step of the agent's run was
// passed down the chain at it (effort.ts `carried`), as the model's `applied` means a rewrite was sent down. A hook
// cannot see whether the engine then sent the request. A step that carries it later marks the record (markCarried).
export const asWritten = (r: SpawnRoute): SpawnRoute => (r.effortApplied === true ? { ...r, effortApplied: carried(r.agentId) } : r)
// Only the agent's newest record is its current run's: an older one (a run before a resume) keeps what it said.
export const marked = (rows: SpawnRoute[], id: string): SpawnRoute[] => {
  const i = rows.findLastIndex((r) => r.agentId === id)
  const r = rows[i]
  if (r === undefined || r.effortApplied !== false || r.effort === null || r.effort === undefined) return rows
  return rows.map((row, j) => (j === i ? { ...row, effortApplied: true } : row))
}

// This session's key in $.store (spawns.ts), set when the session opens; a spawn before that, or after
// a failure to open it, is kept in $.state only, and the failure is a named row.
let routesKey: string | undefined

export async function openRoutes($: EngineInterface, note: Note): Promise<void> {
  routesKey = undefined
  try {
    const now = await $.clock.now()
    const key = spawnsKey(now, await $.session.id())
    for (const stale of staleSpawnKeys(await $.store.keys(), now)) await $.store.delete(stale)
    routesKey = key
  } catch (error) {
    await note('spawn records', `not kept across sessions: ${String(error).slice(0, 100)}`)
  }
}

// The store's reads and writes of this session's key, one at a time: a spawn's record and a step marking it would
// otherwise read the same rows and the later write drop the other's change.
let routeWrites: Promise<void> = Promise.resolve()

export async function rewriteRoutes($: EngineInterface, change: Change, note: Note): Promise<void> {
  const key = routesKey
  if (key === undefined) return
  const write = async (): Promise<void> => {
    try {
      const kept = ((await $.store.get(key)) ?? []) as SpawnRoute[]
      await $.store.set(key, change(kept))
    } catch (error) {
      await note('spawn records', `not kept across sessions: ${String(error).slice(0, 100)}`)
    }
  }
  const done = routeWrites.then(write)
  // A write that failed fails its caller only: the next write still runs.
  routeWrites = done.catch(() => undefined)
  await done
}

export async function keepRoute($: EngineInterface, record: SpawnRoute, note: Note): Promise<void> {
  await rewriteRoutes($, (kept) => [...kept, asWritten(record)].slice(-ROUTES_PER_SESSION), note)
}

// What the record says of the decision. The table's class and review flag ride only a record the table decided (its
// rung is `decided`/`effort`).
export type Decision = { routed: Routed; applied: boolean; steer: Steer; effort: Decided; enforce: boolean }

export const routeOf = ({ routed, applied, steer, effort, enforce }: Decision): RouteFields => ({
  requested: routed.requested,
  definition: routed.definition,
  decided: routed.model ?? routed.stands,
  reason: routed.reason,
  applied,
  ...(steer.by === 'table' ? { cls: steer.cls, review: steer.review } : {}),
  effort: effort.effort ?? null,
  effortReason: effort.reason,
  effortApplied: enforce && effort.effort !== undefined,
})
