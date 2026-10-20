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

export type Route = { agentId: string; type: string; requested: string | null; definition: string | null; decided: string; ran: string; reason: string; applied: boolean; cls?: string; review?: boolean; effort?: string | null; effortReason?: string }
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
  failStateSet?: { key: string; count: number; skip?: number } | { key: string; count: number; skip?: number }[]
  // The spawn classifier's completion (dispatch.ts): `answer` its reply's text, `fails` a reply with no text for that
  // reason, `rejects` a request the engine refuses. Unset, the completion is refused ("no classifier stubbed"), so a
  // completion nobody expected is a row and a count, never a silent class. `asked` keeps each prompt it was sent.
  classifier?: { answer?: string; fails?: 'aborted' | 'empty-reply' | 'api-error'; rejects?: string }
  asked: { model: string; effort?: string; prompt: string }[]
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
    const listed = seen.failStateSet
    const failing = (listed === undefined ? [] : Array.isArray(listed) ? listed : [listed]).find((f) => f.key === set.key)
    if (failing !== undefined && (failing.skip ?? 0) > 0) failing.skip = (failing.skip ?? 0) - 1
    else if (failing !== undefined && failing.count > 0) {
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

export const freshSeen = (): Seen => ({ files: { ...FILES }, sent: [], store: {}, decisions: [], listed: [], listFails: false, toasts: [], rateLimits: [], asked: [] })

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// The one completion the mod asks for: the spawn classifier's.
const modelStubs = (on: On, seen: Seen) => {
  on('model.complete', ($, e) => {
    const c = e as unknown as { model: string; effort?: string; prompt: string }
    seen.asked.push({ model: c.model, effort: c.effort, prompt: c.prompt })
    const k = seen.classifier
    // A stand-in for a call on $ answers { value } (what the call resolves to), or { deny } (what it rejects with).
    if (k?.answer !== undefined) return { value: { isAnswered: true, text: k.answer, usage: USAGE } } as never
    if (k?.fails === 'api-error') return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE } } as never
    if (k?.fails !== undefined) return { value: { isAnswered: false, reason: k.fails, usage: USAGE } } as never
    return { deny: k?.rejects ?? 'no classifier stubbed' }
  })
}

export const stubs = (on: On, seen: Seen) => {
  machineStubs(on, seen)
  storeStubs(on, seen)
  agentStubs(on, seen)
  modelStubs(on, seen)
}

// The Agent tool as the engine runs it: `tool.call` reaches the bottom (the tool runs) and the spawn is raised from
// inside the tool, while the call is still running (2.1.304: the Agent tool raises agent.spawn from its `call`, which
// runs beneath every tool.call hook). The tool answers once the test released it.
export type Tool = { entered?: () => void; release?: Promise<void>; mainHeld?: Promise<void>; failing?: boolean }

export const agentTool = (on: On, tool: Tool) =>
  on('tool.call', async () => {
    tool.entered?.()
    await tool.release
    return { result: 'ok', text: 'ok' } as never
  })

// The model's Agent call, and the spawn its tool raises while the call runs.
type SpawnInput = Record<string, unknown>
type CallInput = { effort?: string | null }

export async function dispatch($: Parameters<TestBody>[0], tool: Tool, input: SpawnInput, call: CallInput = {}) {
  let release = (): void => undefined
  tool.release = new Promise<void>((r) => (release = r))
  const entered = new Promise<void>((r) => (tool.entered = r))
  const args = { tool: 'Agent', tool_use_id: input.tool_use_id, description: 'd', prompt: 'p', subagent_type: input.subagentType, ...call }
  const ran = $.tool.call(args as never)
  await entered
  const spawned = await $.agent.spawn(input as never)
  release()
  await ran
  return spawned
}

// A classifier reply naming a class (dispatch.ts parseClass reads it).
export const graded = (cls: string, review = false) => ({ answer: JSON.stringify({ task_class: cls, review }) })
