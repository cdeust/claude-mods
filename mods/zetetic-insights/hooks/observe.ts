import type { EngineInterface } from 'claude-code'

import type { LiveFriction, OutcomeEvent } from '../types'
import { type BashResult, addFriction, bodyFileOf, eventsOfBash, foldEvent, liveFrictionOf } from './events'
import { isUnderTemp } from './probes'
import { expandHome } from './shared'

// What the turn in progress showed at tool.call, main's and its agents': the outcome events and the
// frictions, flushed into the turn's record at turn.complete (bounded: MAX_EVENTS, MAX_LIVE_FRICTIONS).
let events: { events: OutcomeEvent[]; dropped: number } = { events: [], dropped: 0 }
let frictions: LiveFriction[] = []
// The origin of this session, stamped on every record: set at session.start (isInteractive, cwd), kept across /clear and /resume.
let origin: { nonInteractive?: boolean; tmpCwd?: true } = {}

export const setOrigin = (isInteractive: boolean, cwd: string, temps: readonly (string | undefined)[]): void => {
  origin = {
    nonInteractive: !isInteractive,
    ...(isUnderTemp(cwd, temps.filter((t): t is string => typeof t === 'string')) ? { tmpCwd: true as const } : {}),
  }
}

export const originStamp = (): { nonInteractive?: boolean; tmpCwd?: true } => origin

// The turn's observations, handed to its record and cleared.
export const takeObserved = (): { events: OutcomeEvent[]; eventsDropped: number; frictions: LiveFriction[] } => {
  const out = { events: events.events, eventsDropped: events.dropped, frictions }
  events = { events: [], dropped: 0 }
  frictions = []
  return out
}

const BODY_FILE_MAX = 64 * 1024 // source: own choice, bytes of a review body file read to find its verdict; a review is a few KB (the reviewer protocol posts one comment per verdict)

// A review body kept in a file, read for its verdict: null when it cannot be read or is over BODY_FILE_MAX.
async function readBody($: EngineInterface, path: string): Promise<string | null> {
  try {
    const full = path.startsWith('/') || path.startsWith('~') ? await expandHome($, path) : `${await $.session.cwd()}/${path}`
    if (!(await $.fs.exists(full)) || (await $.fs.stat(full)).size > BODY_FILE_MAX) return null
    return await $.fs.read(full)
  } catch {
    return null
  }
}

// What one finished tool call shows (events.ts): its outcome events when it is a Bash call, its friction
// when it errored or was refused. Never throws and never changes the call: a failure here is no event.
export async function observeCall($: EngineInterface, e: { tool: unknown; agentId?: string; command?: unknown }, ran: BashResult): Promise<void> {
  const f = liveFrictionOf(String(e.tool), ran)
  if (f !== null) frictions = addFriction(frictions, f)
  if (e.tool !== 'Bash' || typeof e.command !== 'string') return
  const file = bodyFileOf(e.command)
  const bodyFile = file === null || ran.isError === true || ran.deny !== undefined ? undefined : await readBody($, file)
  const at = await $.clock.now()
  for (const ev of eventsOfBash({ command: e.command, at, ...(e.agentId === undefined ? {} : { agent: e.agentId }), res: ran, ...(bodyFile === undefined ? {} : { bodyFile }) }))
    events = foldEvent(events, ev)
}

