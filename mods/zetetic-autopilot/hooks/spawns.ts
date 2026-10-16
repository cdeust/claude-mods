// Where a session's spawn routes are kept in the plugin's $.store (4 MiB of JSON in all): one key per
// session, `spawns:<start time, 13 digits>:<session id>`, written by that session alone, so two
// sessions never race on a key. The time leads the key: sorting the keys is sorting the sessions.

import type { SpawnRoute } from '../types'

export const SPAWNS_PREFIX = 'spawns:'
export const STORE_BYTES = 4 * 1024 * 1024 // source: the plugin $.store limit, 4 MiB of JSON in all (Claude Code 2.1.300, $.store in the mods types)

// Which sessions' keys the next start deletes. The newest KEEP_SESSIONS stay. A session started less than
// LIVE_TTL_MS ago stays too, beyond them, up to HARD_SESSIONS: it may still be running, and deleting its
// key would drop the routes it has already written (review of PR 25, B1). Past HARD_SESSIONS the oldest
// goes whatever its age, so the store stays bounded.
export const KEEP_SESSIONS = 20 // source: own choice, three weeks of daily sessions; the bound below
export const HARD_SESSIONS = 2 * KEEP_SESSIONS // source: own choice, room for as many again that are younger than the TTL
// source: measured 2026-10-15 over the 32 session transcripts on this machine (~/.claude/projects, file birth to last write): longest 57.9 h, p95 25.1 h; seven days is three times the longest
export const LIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const ROUTES_PER_SESSION = 100 // source: own choice, above the 12 loops a pane lists (LOOPS_CAP) many times over and far above what one session starts; the oldest is dropped past it

// Every string a record keeps is clipped, so the size of a record has a ceiling and the store a bound.
export const CLIP = { agentId: 40, type: 64, model: 48 } as const // source: own choice, above the longest id, `plugin:agent` name and model id seen (agent ids ~17 characters, `zetetic-team-subagents:security-auditor` 39, `claude-haiku-4-5-20251001` 25)

export const clip = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max))

export const clipped = (r: SpawnRoute): SpawnRoute => ({
  ...r,
  agentId: clip(r.agentId, CLIP.agentId),
  type: clip(r.type, CLIP.type),
  requested: r.requested === null ? null : clip(r.requested, CLIP.model),
  definition: r.definition === null ? null : clip(r.definition, CLIP.model),
  decided: clip(r.decided, CLIP.model),
  ran: clip(r.ran, CLIP.model),
})

export const spawnsKey = (startedAt: number, sessionId: string): string =>
  `${SPAWNS_PREFIX}${String(Math.trunc(startedAt)).padStart(13, '0')}:${sessionId}`

const startOf = (key: string): number => Number(key.slice(SPAWNS_PREFIX.length, SPAWNS_PREFIX.length + 13))

// The keys to delete so that, with the key about to be written, the rule above holds. `now` is the
// clock the engine reports (a timestamp, not a wait: nothing here sleeps or schedules).
export const staleSpawnKeys = (keys: readonly string[], now: number, keep = KEEP_SESSIONS, hard = HARD_SESSIONS, ttl = LIVE_TTL_MS): string[] => {
  const ours = keys.filter((k) => k.startsWith(SPAWNS_PREFIX)).sort()
  return ours.filter((k, i) => {
    const newerThanIt = ours.length - 1 - i // sessions that started after this one
    if (newerThanIt >= hard - 1) return true
    const isLive = now - startOf(k) < ttl
    return newerThanIt >= keep - 1 && !isLive
  })
}
