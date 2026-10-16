// The quota's cap on parallel subagents as the engine sees it (concurrency.ts holds the pure rules): who
// runs, who is being admitted, and the refusal. The policy state and the phases rows stay in register.tsx,
// behind a `GateSink`, as offloadrow.ts does for the offload.
import type { EngineInterface } from 'claude-code'

import type { PolicyDecision, PolicyState } from '../types'
import { MAX_PARALLEL_AGENTS, fiveHourPercent, isRefused, parallelCap, refusalMessage, stillRunning } from './concurrency'

// What the gate tells the rest of the mod: a cap row, a reading it could not make, an agent the engine
// says is gone.
export type GateSink = {
  decide: (d: PolicyDecision) => Promise<void>
  note: (subject: string, reason: string) => Promise<void>
  gone: (id: string, at: number) => Promise<void>
}

// The subagents running now, by id: added when their spawn answers, removed by their turn.complete. Kept in
// this module's memory and not in $.state, because a hook does not see a state row written by a spawn made in the
// same dispatch: two $.agent.spawn calls one after the other inside one hook did not see each other's row (measured
// live 2026-10-15; the engine's docs say nothing of it). `admitting` counts the spawns the gate let through whose
// answer has not come back, so two raised together cannot both pass a cap of one. Both reset with the session.
const live = new Set<string>()
let admitting = 0

// The most subagents running at once with a free quota (the max_parallel_agents option), set when the mod loads.
let maxParallel = MAX_PARALLEL_AGENTS

export const configureGate = (max: number): void => {
  maxParallel = max
}

export const resetGate = (): void => {
  admitting = 0
  live.clear()
}

export const started = (id: string): void => {
  live.add(id)
}

export const ended = (id: string): void => {
  live.delete(id)
}

export const released = (held: boolean): void => {
  if (held) admitting = Math.max(0, admitting - 1)
}

// The agents the engine's list no longer shows alive leave the set and close their phases rows.
async function confirmRunning($: EngineInterface, running: string[], at: number, sink: GateSink): Promise<string[]> {
  const alive = stillRunning(running, await $.agent.list())
  for (const gone of running.filter((id) => !alive.includes(id))) {
    live.delete(gone)
    await sink.gone(gone, at)
  }
  return [...live]
}

// The quota's limit on parallel subagents (concurrency.ts). `held` is true when the spawn passed and is
// counted until it answers; `deny` is the reason the spawn is refused. The check and the count are one
// synchronous step after the reads, so no other spawn hook sits between them. A failure of the gate
// itself admits the spawn and says so in a row, so a broken reading refuses nothing.
export async function admit(
  $: EngineInterface,
  e: { subagentType: string },
  p: PolicyState,
  sink: GateSink,
): Promise<{ held: boolean; deny?: string }> {
  try {
    // The window as the engine reports it now: the context atom is written by session.measure and was one step
    // behind when a spawn hook read it (measured live 2026-10-15, a measure that came after the batch's first spawn).
    const used = fiveHourPercent((await $.session.usage()).rateLimits)
    const cap = parallelCap(used, p.quotaPercent, maxParallel)
    const at = await $.clock.now()
    let running = [...live]
    if (running.length > 0 && isRefused(running.length + admitting, cap)) {
      // The count is event-based; before refusing, the engine's own list confirms who still runs.
      running = await confirmRunning($, running, at, sink)
    }
    const count = running.length + admitting
    if (!isRefused(count, cap)) {
      admitting += 1
      return { held: true }
    }
    const message = refusalMessage(count, cap, used, p.quotaPercent, maxParallel)
    const applied = p.mode === 'enforce'
    await sink.decide({ at, kind: 'cap', subject: e.subagentType, from: `${count} running`, to: `cap ${cap}`, applied, reason: message })
    if (!applied) return { held: true }
    $.ui.toast(message)
    return { held: false, deny: message }
  } catch (error) {
    await sink.note('agent cap', `not applied: ${String(error).slice(0, 100)}`)
    return { held: false }
  }
}
