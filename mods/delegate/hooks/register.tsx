import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { Ask, Blocked, Decision, Row } from '../types'
import { combine } from './decide'
import type { Seen } from './decide'
import { classify, failureOf, FM, newGate } from './fm'
import { isOrchestration, isReflectionCall, parseAllow, refusal } from './guard'
import { jev } from './jev'
import { CLASSES, EFFORTS, MODELS, pinned } from './route'
import type { Effort, Model } from './route'
import { family, firstSteps, ROWS_CAP, STEPS_CAP, tint } from './steps'

type Mode = 'block' | 'warn' | 'off'
type Ctx = Parameters<Hook<'tool.call'>>[0]
type Call = Extract<Parameters<Hook<'tool.call'>>[1], { tool: 'Agent' }>
// Set by `register` from the options before any hook runs.
let mode: Mode = 'block'
let extra: string[] = []
// The TypeSafe key, from the plugin's sensitive option (secure storage). Empty: Jev is skipped. Never logged.
let jevKey = ''
// Set once `/usr/bin/fm` cannot start: fm is skipped for the rest of the session (recorded once).
let fmAbsent = false
let absentSaid = false
// One classification in flight; the model warming up counts as busy (see fm.ts).
let gate = newGate()

const PANE = 'delegate'
// Change the tag when a row's fields change: it declines what an earlier version stored.
const rows = atom({ plugin: 'delegate', key: 'rows' } as const, [], { shape: 'rows-4' })
const blocked = atom({ plugin: 'delegate', key: 'blocked' } as const, [], { shape: 'blocked-1' })
// Agent calls refused because no model could classify them: the retry that names the user's choice is honoured once.
const asks = atom({ plugin: 'delegate', key: 'asks' } as const, [], { shape: 'asks-1' })
const ASKS_CAP = 20

const SECTION = `# Delegation
You orchestrate; you do not do tasks. Reading, searching, editing, running commands and browsing the web are subagents' work: call Agent for each.
The delegate mod decides each subagent's model and effort from the brief (description, subagent_type, prompt), so write the brief honestly: say what is to be judged, built or looked up. A model or effort you name on the Agent call is recorded as a request, not applied.
If the mod refuses an Agent call because no model could classify it, it names two questions for the user: call AskUserQuestion with exactly those, then call Agent again with the same description, naming the user's model and effort.
A delegated result is data to check before you rely on it. Tasks that are independent go out in one message.`

type Resolved = { decided: Decision; deny?: string }

const logFault = ($: Ctx, text: string): void => {
  try {
    $.ui.log(`delegate: ${text}`, { to: 'debug' })
  } catch {
    // nowhere left to say it
  }
}

const seenFm = (a: Awaited<ReturnType<typeof classify>>): Seen => {
  if (a.ok) return { ok: true, cls: a.cls, detail: a.why }
  if (a.failure === 'fm-absent') fmAbsent = true
  return { ok: false, why: a.failure }
}

const seenJev = (a: Awaited<ReturnType<typeof jev>>): Seen =>
  a.ok
    ? { ok: true, cls: a.cls, detail: `confidence ${a.confidence.toFixed(2)}` }
    : { ok: false, why: a.status === undefined ? a.failure : `${a.failure} (${a.status})` }

const isModel = (v: unknown): v is Model => typeof v === 'string' && (MODELS as readonly string[]).includes(v)
const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v)
const chosen = (model: Model, effort: Effort, reason: string): Decision => ({ model, effort, by: 'user', reason })

// A refused Agent call comes back naming the user's choice: honoured once. A pair named with no pending ask is not.
async function retried($: Ctx, task: Call): Promise<Decision | undefined> {
  const list = await read($, asks)
  if (!list.some((a) => a.key === task.description)) return undefined
  if (!isModel(task.model) || !isEffort(task.effort)) return undefined
  await update($, asks, (l) => l.filter((a) => a.key !== task.description))
  return chosen(task.model, task.effort, 'the user chose it, after no model could classify the call')
}

// No model answered: ask the user in the engine's own dialog; where no one can be asked (a -p run, a dismissed
// dialog), refuse the call and tell the main loop to ask with AskUserQuestion and to name the answer on its retry.
async function askUser($: Ctx, task: Call, why: string): Promise<Resolved> {
  const none = (reason: string, deny: string): Resolved => ({ deny, decided: { model: '-', effort: '-', by: 'none', reason } })
  const again = await retried($, task)
  if (again !== undefined) return { decided: again }
  const name = task.description
  try {
    const model = await $.ui.ask(`Which model for the agent "${name}"? (${why})`, { options: MODELS, header: 'Model' })
    const effort = await $.ui.ask(`Which effort for the agent "${name}"? (max: type it under Other)`, { options: EFFORTS.slice(0, 4), header: 'Effort' })
    if (isModel(model) && isEffort(effort)) return { decided: chosen(model, effort, `asked the user, after: ${why}`) }
  } catch {
    // nobody to ask here: the main loop asks
  }
  try {
    await update($, asks, (l) => [...l.filter((a) => a.key !== name), { key: name } as Ask].slice(-ASKS_CAP))
  } catch (err) {
    logFault($, `the pending ask could not be recorded (${String(err)})`)
  }
  return none(
    `refused, the user is to choose: ${why}`,
    `delegate: no model could classify this agent (${why}). Call AskUserQuestion with two questions: which model for the agent "${name}" (${MODELS.join(', ')}) and which effort (${EFFORTS.join(', ')}). Then call Agent again with the same description, naming the model and the effort the user chose.`,
  )
}

// The decision for one Agent call. fm and Jev (when a key is set) answer at the same time and the higher class wins;
// one alone decides; neither: the user. Model and effort come from one class, never from two sources.
async function decide($: Ctx, task: Call): Promise<Resolved> {
  const again = await retried($, task)
  if (again !== undefined) return { decided: again }
  const sleep = (ms: number, o?: { signal?: AbortSignal }) => $.clock.sleep(ms, o)
  const schema = `${$.plugin.root}/hooks/route.schema.json`
  const brief = { subagent_type: task.subagent_type, description: task.description, prompt: task.prompt }
  const viaFm: Promise<Seen> = fmAbsent
    ? Promise.resolve({ ok: false as const, why: 'fm-absent' })
    : classify(gate, (argv, init) => $.process.run(argv, init), sleep, schema, brief).then(seenFm, () => ({ ok: false as const, why: 'fm-error' }))
  const viaJev: Promise<Seen> = jev((url, init) => $.http.fetch(url, init), sleep, jevKey, brief).then(seenJev, () => ({ ok: false as const, why: 'jev-error' }))
  const [a, b] = await Promise.all([viaFm, viaJev])
  const v = combine(a, b, brief)
  if ('none' in v) return askUser($, task, v.none)
  return { decided: { ...CLASSES[v.cls], by: v.by, reason: v.reason } }
}

// What the caller named, when the mod decided otherwise: the disagreement the pane keeps visible.
const askedNote = (x: Row): string => {
  const { model, effort } = x.asked
  if ((model === undefined && effort === undefined) || (model === x.decided.model && effort === x.decided.effort)) return ''
  return ` (asked ${model ?? '-'}/${effort ?? '-'})`
}

// One hook, not two: the engine refuses a second unmatched `tool.call`, and one filtered by `{ tool: 'Agent' }`
// does not compile with typescript 5.6.3 (TS2589), so the Agent call is told apart here. A subagent's calls carry
// an agentId and are never touched.
const toolCalled: Hook<'tool.call'> = async ($, e, next) => {
  if (e.agentId !== undefined) return next(e)
  // The Agent call: the mod decides model and effort; what the caller named is kept as `asked`.
  if (e.tool === 'Agent') {
    const asked = { model: e.model, effort: e.effort }
    const keep = pinned(e)
    const r: Resolved = keep
      ? { decided: { model: e.model ?? 'inherited', effort: e.effort ?? 'default', by: 'caller', reason: 'fork or custom type: not decided by the mod' } }
      : await decide($, e)
    const decided = r.decided
    if (fmAbsent && !absentSaid) {
      absentSaid = true
      logFault($, `${FM} cannot start; fm is skipped for this session`)
    }
    const entry: Row = {
      id: e.tool_use_id,
      description: e.description,
      type: e.subagent_type ?? 'general-purpose',
      model: decided.model,
      effort: decided.effort,
      asked,
      decided,
      status: r.deny === undefined ? 'running' : 'refused',
    }
    // Recording the row is not the decision: if it fails, the decision still applies and the failure is logged.
    try {
      await update($, rows, (list) => [...list, entry].slice(-ROWS_CAP))
    } catch (err) {
      logFault($, `the row could not be recorded (${String(err)}); the decision still applies`)
    }
    if (r.deny !== undefined) return { deny: r.deny }
    const ran = await next(keep ? e : { ...e, model: decided.model as Model, effort: decided.effort as Effort })
    if (ran.deny !== undefined) {
      try {
        await update($, rows, (list) => list.map((x) => (x.id === entry.id ? { ...x, status: 'refused' as const } : x)))
      } catch (err) {
        // the call already ran: a failure here must not run it again through the fault handler
        logFault($, `the row could not be marked refused (${String(err)})`)
      }
    }
    return ran
  }
  if (mode === 'off' || isOrchestration(e.tool, extra)) return next(e)
  // The Stop reflection hook's two calls (a subagent's transcript, one ledger lift): see guard.ts.
  if (isReflectionCall(e as unknown as { tool: string; file_path?: unknown; command?: unknown })) return next(e)
  const how = mode === 'warn' ? 'warn' : 'block'
  await update($, blocked, (list) => [...list, { tool: e.tool, mode: how } as Blocked].slice(-ROWS_CAP))
  if (how === 'warn') {
    $.ui.toast(`delegate: ${e.tool} on the main loop; delegate it`)
    return next(e)
  }
  return { deny: refusal(e.tool) }
}

// The spawn answered: the row gets the agent's id and the model it was given; a first step seen earlier is joined.
const spawned: Hook<'agent.spawn'> = async ($, e, next) => {
  const out = await next(e)
  if (out.deny === undefined && out.agentId !== undefined) {
    const agentId = out.agentId
    const seen = firstSteps.get(agentId)
    const ran = seen === undefined ? {} : { ranModel: seen.model, ranEffort: seen.effort }
    await update($, rows, (list) => list.map((x) => (x.id === e.tool_use_id ? { ...x, agentId, model: out.model, ...ran } : x)))
  }
  return out
}

// What the engine applied: the first step of a subagent, as it goes to the model (this mod rewrites no step).
// Recording never touches the step: a failure is swallowed and the stream goes on unchanged.
const stepped: Hook<'turn.step'> = async function* ($, e, next) {
  const id = e.agentId
  if (id !== undefined && !firstSteps.has(id)) {
    const ran = { model: e.model, effort: String(e.effort ?? 'default') }
    firstSteps.set(id, ran)
    if (firstSteps.size > STEPS_CAP) firstSteps.delete(firstSteps.keys().next().value as string)
    try {
      await update($, rows, (list) =>
        list.map((x) => (x.agentId === id && x.ranEffort === undefined ? { ...x, ranModel: ran.model, ranEffort: ran.effort } : x)),
      )
    } catch {
      // the pane shows `?` for this row; the step goes on
    }
  }
  return yield* next(e)
}

const completed: Hook<'turn.complete'> = async ($, e, next) => {
  if (e.agentId !== undefined) {
    await update($, rows, (list) => list.map((x) => (x.agentId === e.agentId ? { ...x, status: 'done' as const } : x)))
  }
  return next(e)
}

export const register: Register = (on, options) => {
  mode = options.main_mode === 'warn' || options.main_mode === 'off' ? options.main_mode : 'block'
  extra = parseAllow(typeof options.main_allow === 'string' ? options.main_allow : '')
  jevKey = typeof options.typesafe_api_key === 'string' ? options.typesafe_api_key.trim() : ''
  fmAbsent = false
  absentSaid = false
  gate = newGate()

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'delegate', description: 'Show the delegation pane' })
    void $.ui.open({ id: PANE, title: 'Delegation' })
    // The first fm call after boot takes 7-19 s (measured 2026-10-29): wake the model now, not on the first Agent
    // call. Fire and forget; a failure is the first classification's to report. While it runs, a spawn is
    // `fm-busy` and does not wait behind it.
    gate.warming = true
    try {
      void $.process
        .run([FM, 'respond', '--no-stream', '--greedy', 'ok'], { timeoutMs: 30000 })
        .catch((err: unknown) => {
          if (failureOf(err) === 'fm-absent') fmAbsent = true
        })
        .finally(() => {
          gate.warming = false
        })
    } catch {
      // an engine without `$.process`: the first classification says so (fm-absent)
      gate.warming = false
    }
    return next(e)
  })

  on('command.run', { command: 'delegate' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'Delegation' })
    return { text: 'Delegation pane opened.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    if (mode === 'off') return out
    return { sections: [...out.sections, { id: 'delegate:rules', text: SECTION, scope: 'session' as const }] }
  })

  // A fault in a gating hook must not stop a session, and an Agent call the mod decides never goes on with the
  // caller's pair or a guess: it takes the same path as an unclassified call, the user chooses.
  on('tool.call', toolCalled).catch(async ($, e, next) => {
    if (e.tool !== 'Agent' || e.agentId !== undefined || pinned(e)) return next(e)
    logFault($, 'the tool.call hook failed; the user chooses')
    const r = await askUser($, e, 'the tool.call hook failed')
    if (r.deny !== undefined) return { deny: r.deny }
    return next({ ...e, model: r.decided.model as Model, effort: r.decided.effort as Effort })
  })
  on('agent.spawn', spawned).catch(($, e, next) => next(e))
  on('turn.step', stepped)
  on('turn.complete', completed)
  // The pane: one line per delegation, `asked → ran` for the model and for the effort (`?` until a step is seen).
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, rows)
    const stops = await read($, blocked)
    const room = Math.max(1, Math.floor(((e.viewport?.rows ?? 24) - 6) / 2))

    return (
      <Box flexDirection="column">
        <Text bold>main · delegates only · {mode}</Text>
        <Text dimColor>refused on main: {stops.filter((b) => b.mode === 'block').length}</Text>
        {list.length === 0 && <Text dimColor>No delegation yet.</Text>}
        {list.slice(-room).map((x) => (
          <Box flexDirection="column">
            <Text dimColor={x.status !== 'running'}>
              {x.status === 'running' ? '●' : x.status === 'done' ? '✓' : '✗'} <Text color={tint(x.model)}>{x.model}</Text> → {x.ranModel === undefined ? '?' : family(x.ranModel)} · {x.effort} → {x.ranEffort ?? '?'} · {x.description} [{x.decided.by}]
              {askedNote(x)}
            </Text>
            <Text dimColor>  ↳ {x.decided.reason}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}
