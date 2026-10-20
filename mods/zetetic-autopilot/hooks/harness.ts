import { mock } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// The fake machine the spawn wiring tests share: a disk with the zetetic agents' definitions, a store, the
// engine's agent list, and a spawn that answers `ag-<n>` once it started. Not a test file: the tests import it.

export const FABLE = 'claude-fable-5-1'
const ZETETIC = '/c/zetetic/2.44.0'
export const FILES: Record<string, string> = {
  '/home/t/.claude/plugins/installed_plugins.json': JSON.stringify({
    plugins: { 'zetetic-team-subagents@zetetic-marketplace': [{ installPath: ZETETIC }] },
  }),
  // The Stop guard's marks (context.ts), as the owner's file has them for every model.
  '/home/t/.claude/ctxguard-thresholds.json': JSON.stringify({ models: [], default: { warn: 180_000, hard: 200_000 } }),
  [`${ZETETIC}/agents/engineer.md`]: '---\nname: engineer\nmodel: sonnet\neffort: medium\n---\n',
  [`${ZETETIC}/agents/architect.md`]: '---\nname: architect\nmodel: opus\n---\n',
}
export const ENGINEER = 'zetetic-team-subagents:engineer'
export const ARCHITECT = 'zetetic-team-subagents:architect'

export type Route = { agentId: string; type: string; requested: string | null; definition: string | null; decided: string; ran: string; reason: string; applied: boolean }
export type Decision = { kind: string; reason?: string; to: string; from: string; subject: string; applied: boolean }
export type ListedAgent = { id: string; status: string }
export type Seen = {
  files: Record<string, string>
  sent: (string | undefined)[]
  store: Record<string, Route[]>
  spawns?: Route[]
  decisions: Decision[]
  // What the engine's $.agent.list() answers; `listFails` makes it throw.
  listed: ListedAgent[]
  listFails: boolean
  toasts: string[]
  // The rate limits of the last measure, which session.usage answers.
  rateLimits: { kind: string; percentUsed: number }[]
  // When set, a spawn that reaches the engine says so (`entered`) and answers only once `release` settles.
  hold?: { entered: () => void; release: Promise<void> }
  // zetetic-genius's verdict as its state holds it; absent, the dependency has graded nothing.
  grade?: { turnId: string | null; taskClass: string; effort: string }
  // When set, the next spawn answers this id: a message resumed that agent, which keeps its id.
  resumes?: string
  // When set, the spawn starts the agent's run before it answers, as a background launch does (2.1.304: the run is
  // started, then the spawn answers), without waiting on the run.
  launch?: (agentId: string) => void
  // When set, a spawn that launched its run answers only once this settles (taken by the first spawn that reads it).
  answerHeld?: Promise<void>
  // When set, the mod's next read of its own `spawns` state finds these rows (once): a state already filled.
  spawnsState?: Route[]
  // How many of the next writes the engine refuses ({ deny }, as a failed write answers): the store's, and the
  // mod's own state by key.
  failStoreSet?: number
  failStateSet?: { key: string; count: number; skip?: number }
}

type On = Parameters<TestBody>[1]

// The session, its clock, the disk and the dependency's state.
const machineStubs = (on: On, seen: Seen) => {
  mock.clock(on, { now: 1_000_000 })
  on('session.start', () => ({ cwd: '/r' }))
  on('session.cwd', () => ({ value: '/r' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: seen.rateLimits, cost: { usd: 0 } } as never }))
  on('session.model', () => ({ value: FABLE }))
  on('env.get', ($, e) => ({ value: ((e as { name?: string }).name === 'HOME' ? '/home/t' : undefined) as never }))
  on('fs.exists', ($, e) => ({ value: String((e as { path?: string }).path ?? '') in seen.files }))
  on('fs.read', ($, e) => {
    const path = String((e as { path?: string }).path ?? '')
    const text = seen.files[path]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('state.get', async ($, e, next) => {
    const get = e as { plugin?: string; key?: string }
    if (get.plugin === 'zetetic-genius')
      return { value: { value: seen.grade === undefined ? undefined : { classified: seen.grade }, version: 0 } as never }
    const filled = get.key === 'spawns' ? seen.spawnsState : undefined
    if (filled === undefined) return next(e)
    seen.spawnsState = undefined
    // The engine's own answer, its version kept, with the rows the test filled it with.
    const real = await next(e)
    return { ...real, value: { ...(real as { value: object }).value, value: filled } } as never
  })
  on('state.set', ($, e, next) => {
    const set = e as unknown as { key?: string; value: never }
    const failing = seen.failStateSet
    if (failing !== undefined && failing.key === set.key && (failing.skip ?? 0) > 0) failing.skip = (failing.skip ?? 0) - 1
    else if (failing !== undefined && failing.key === set.key && failing.count > 0) {
      failing.count -= 1
      return { deny: `${set.key} state offline` }
    }
    if (set.key === 'spawns') seen.spawns = set.value
    if (set.key === 'policy') seen.decisions = (set.value as { decisions: Seen['decisions'] }).decisions
    return next(e)
  })
}

// The plugin's $.store, in memory.
const storeStubs = (on: On, seen: Seen) => {
  on('session.id', () => ({ value: 'sid-1' }))
  on('store.keys', () => ({ value: Object.keys(seen.store) as never }))
  on('store.get', ($, e) => ({ value: seen.store[String((e as { key?: string }).key)] as never }))
  on('store.set', ($, e) => {
    if ((seen.failStoreSet ?? 0) > 0) {
      seen.failStoreSet = (seen.failStoreSet ?? 0) - 1
      return { deny: 'store offline' }
    }
    const { key, value } = e as unknown as { key: string; value: Route[] }
    seen.store[key] = JSON.parse(JSON.stringify(value))
    return { value: undefined as never }
  })
  on('store.delete', ($, e) => {
    delete seen.store[String((e as { key?: string }).key)]
    return { value: undefined as never }
  })
}

// What the engine answers about the quota, the toasts and the agents.
const agentStubs = (on: On, seen: Seen) => {
  on('session.measure', ($, e) => {
    seen.rateLimits = [...e.rateLimits]
    return { changed: e.changed }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push((e as unknown as { text: string }).text)
    return { value: undefined as never }
  })
  on('agent.list', () => {
    if (seen.listFails) throw new Error('agent list offline')
    return { value: seen.listed as never }
  })
  on('turn.complete', ($, e) => {
    const gone = seen.listed.find((a) => a.id === e.agentId)
    if (gone !== undefined) gone.status = 'completed'
    return { text: '' }
  })
  // The spawn answers after a tick, so two raised together are both in flight before either answers.
  on('agent.spawn', async ($, e) => {
    await Promise.resolve()
    if (seen.hold !== undefined) {
      seen.hold.entered()
      await seen.hold.release
    }
    seen.sent.push(e.model)
    const agentId = seen.resumes ?? `ag-${seen.sent.length}`
    seen.resumes = undefined
    seen.listed.push({ id: agentId, status: 'running' })
    seen.launch?.(agentId)
    const held = seen.answerHeld
    seen.answerHeld = undefined
    if (held !== undefined) await held
    return { model: e.model ?? 'sonnet', agentId }
  })
}

export const spawn = (subagentType: string, model?: string) =>
  ({
    tool_use_id: 'a1',
    prompt: 'p',
    description: 'd',
    subagentType,
    provider: { kind: 'model', model: FABLE },
    parentModel: FABLE,
    ...(model === undefined ? {} : { model }),
  }) as never

// The agent's turn ends (its answer, or an interrupt): the engine raises turn.complete with its id.
export const done = (id: string) =>
  ({ turnId: `t-${id}`, agentId: id, answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' }) as never

// The orchestrator's context past the Stop guard's hard mark (the owner's session held 360 184 tokens
// against 200 000), and the five-hour window at a given use.
export const CONTEXT = { context: { window: 1_000_000, tokens: 360_184, percent: 36 }, rateLimits: [{ kind: 'five_hour', percentUsed: 8 }], changed: ['context'] } as never
export const used = (percent: number) =>
  ({ context: { window: 1_000_000, tokens: 1000, percent: 1 }, rateLimits: [{ kind: 'five_hour', percentUsed: percent }], changed: ['rateLimits'] }) as never
export const QUOTA = used(90)
export const ENFORCE = { policy_mode: 'enforce', quota_pressure_percent: 80 }

export type Body = (engine: Parameters<TestBody>[0], seen: Seen) => Promise<void>

export const freshSeen = (): Seen => ({ files: { ...FILES }, sent: [], store: {}, decisions: [], listed: [], listFails: false, toasts: [], rateLimits: [] })

export const stubs = (on: On, seen: Seen) => {
  machineStubs(on, seen)
  storeStubs(on, seen)
  agentStubs(on, seen)
}
