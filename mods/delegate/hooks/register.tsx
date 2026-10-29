import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { Ask, Blocked, Decision, Row } from '../types'
import { combine } from './decide'
import type { Seen } from './decide'
import { classify, FM, newGate, warm } from './fm'
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
// Agent calls refused because no model could classify them. Each carries a mark (a nonce) that the questions the main
// loop asks the user repeat; the user's answer, seen on that AskUserQuestion, is what a retry applies, once. The main loop's
// turn start and end drop them all (a subagent's do not).
const asks = atom({ plugin: 'delegate', key: 'asks' } as const, [], { shape: 'asks-2' })
const ASKS_CAP = 20
const MARK = /\[ask ([0-9a-z]+):(model|effort)\]/g
// The mod's own mark is the last one in a question (the canonical text ends with it); a description may hold look-alikes before it.
const lastMark = (text: string): { mark: string; field: 'model' | 'effort' } | null => {
  const all = [...text.matchAll(MARK)]
  const m = all[all.length - 1]
  return m === undefined ? null : { mark: m[1] as string, field: m[2] as 'model' | 'effort' }
}
let issued = 0
const newMark = (): string => `${(++issued).toString(36)}${Math.random().toString(36).slice(2, 8)}`

const SECTION = `# Delegation
You orchestrate; you do not do tasks. Reading, searching, editing, running commands and browsing the web are subagents' work: call Agent for each.
The delegate mod decides each subagent's model and effort from the brief (description, subagent_type, prompt), so write the brief honestly: say what is to be judged, built or looked up. A model or effort you name on the Agent call is recorded as a request, not applied.
If the mod refuses an Agent call because no model could classify it, it names two questions for the user, each ending in a bracketed mark: call AskUserQuestion with exactly those, marks included, then call Agent again with the same description. The mod applies what the user answered, whatever the second call names.
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

// The two questions of a refusal, worded here and nowhere else: a call of the main loop that carries the marks is rewritten
// to these (text, options), so the user is always offered the whole lists, whatever the main loop wrote.
const modelQuestion = (name: string, mark: string): string => `Which model for the agent "${name}"? (${MODELS.join(', ')}) [ask ${mark}:model]`
const effortQuestion = (name: string, mark: string): string => `Which effort for the agent "${name}"? (${EFFORTS.join(', ')}) [ask ${mark}:effort]`
const canonicalQuestion = (name: string, mark: string, field: 'model' | 'effort') => {
  const labels: readonly string[] = field === 'model' ? MODELS : EFFORTS.slice(0, 4) // max: typed under "Other", as $.ui.ask
  return {
    question: field === 'model' ? modelQuestion(name, mark) : effortQuestion(name, mark),
    header: field === 'model' ? 'Model' : 'Effort',
    options: labels.map((label) => ({ label, description: label })),
    multiSelect: false,
  }
}
// What the main loop may not have written into the call, or what shows the dialog did not resolve on a person's choice.
const FROM_ELSEWHERE = ['answers', 'annotations', 'response', 'afkTimeoutMs', 'followUp'] as const

// The call, with its marked questions replaced by the mod's own; `clean` is false when it carried answers of its own
// (the engine returns an input's `answers`), which then are neither sent on nor taken for the user's. `asked` lists the
// questions the mod worded, each with the entry it belongs to: the capture pairs an answer with these, by the text, and
// never reads a mark out of a question again (a description can hold one). A mark and field already worded once are
// not worded twice (the dialog refuses two questions with the same text).
type Worded = { question: string; mark: string; field: 'model' | 'effort' }
async function canonical($: Ctx, e: object): Promise<{ input: object; clean: boolean; asked: Worded[] }> {
  const x = e as Record<string, unknown>
  const marked = (q: unknown) => (typeof (q as { question?: unknown } | undefined)?.question === 'string' ? lastMark((q as { question: string }).question) : null)
  if (!Array.isArray(x.questions) || !x.questions.some((q) => marked(q) !== null)) return { input: e, clean: false, asked: [] }
  const list = await read($, asks)
  const asked: Worded[] = []
  const questions: unknown[] = []
  for (const q of x.questions) {
    const m = marked(q)
    const entry = m === null ? undefined : list.find((a) => a.mark === m.mark)
    if (m === null || entry === undefined) {
      questions.push(q)
      continue
    }
    const w = canonicalQuestion(entry.key, entry.mark, m.field)
    if (asked.some((a) => a.mark === entry.mark && a.field === m.field)) continue
    asked.push({ question: w.question, mark: entry.mark, field: m.field })
    questions.push(w)
  }
  const clean = !FROM_ELSEWHERE.some((k) => Object.hasOwn(x, k))
  const input: Record<string, unknown> = { ...x, questions }
  for (const k of FROM_ELSEWHERE) delete input[k]
  return { input, clean, asked }
}

// The pair the user chose for this description, in an AskUserQuestion that carried the mod's mark: taken once. Only the
// user's answer, seen on that call, is ever applied; what the retry names is ignored. The take is one `update`, so of
// any number of retries in parallel one wins (a version miss reruns `change`, and only the last run's `won` counts).
async function retried($: Ctx, task: Call): Promise<Decision | undefined> {
  let won: Ask | undefined = undefined as Ask | undefined
  await update($, asks, (l) => {
    won = l.find((a) => a.key === task.description && isModel(a.model) && isEffort(a.effort))
    const mark = won?.mark
    return mark === undefined ? l : l.filter((a) => a.mark !== mark)
  })
  const got = won as Ask | undefined
  if (got === undefined || !isModel(got.model) || !isEffort(got.effort)) return undefined
  return chosen(got.model, got.effort, 'the user chose it, after no model could classify the call')
}

// The main loop's AskUserQuestion has been answered: an answer to a question that carries a mark the mod issued, and is
// a model (or an effort), is kept for that mark's entry. A denied call, an error, an unmarked question, a mark never
// issued, an answer that is not one of the lists: nothing is kept.
async function captured($: Ctx, e: { questions?: unknown }, asked: readonly Worded[], ran: { deny?: string; isError?: true; result?: unknown }): Promise<void> {
  if (ran.deny !== undefined || ran.isError === true || !Array.isArray(e.questions)) return
  // A dialog that resolved on the user's idle time (afkTimeoutMs) holds unconfirmed selections: not a choice.
  if (typeof ran.result === 'object' && ran.result !== null && Object.hasOwn(ran.result, 'afkTimeoutMs')) return
  // Nor one where the user asked for another round of questions (followUp) instead of answering.
  const follow = (ran.result as { followUp?: unknown } | null | undefined)?.followUp
  if (follow !== undefined && follow !== false) return
  const said = (ran.result as { answers?: unknown } | undefined)?.answers
  if (typeof said !== 'object' || said === null) return
  const got: Array<{ mark: string; field: 'model' | 'effort'; value: string }> = []
  for (const q of e.questions as Array<{ question?: unknown }>) {
    if (typeof q?.question !== 'string') continue
    const w = asked.find((a) => a.question === q.question) // the mod's own wording, by equality
    const answer = (said as Record<string, unknown>)[q.question]
    if (w === undefined || typeof answer !== 'string') continue
    const value = answer.trim()
    if (w.field === 'model' ? isModel(value) : isEffort(value)) got.push({ mark: w.mark, field: w.field, value })
  }
  if (got.length === 0) return
  await update($, asks, (l) =>
    l.map((a) => got.reduce((x, g) => (x.mark === g.mark ? { ...x, [g.field]: g.value } : x), a)),
  )
}

// No model answered: ask the user in the engine's own dialog; where no one can be asked (a -p run, a dismissed
// dialog), refuse the call and tell the main loop to ask with AskUserQuestion, with the mod's marked questions.
async function askUser($: Ctx, task: Call, why: string): Promise<Resolved> {
  const name = task.description
  try {
    const model = await $.ui.ask(`Which model for the agent "${name}"? (${why})`, { options: MODELS, header: 'Model' })
    const effort = await $.ui.ask(`Which effort for the agent "${name}"? (max: type it under Other)`, { options: EFFORTS.slice(0, 4), header: 'Effort' })
    if (isModel(model) && isEffort(effort)) return { decided: chosen(model, effort, `asked the user, after: ${why}`) }
  } catch {
    // nobody to ask here: the main loop asks
  }
  const mark = newMark()
  try {
    await update($, asks, (l) => [...l, { key: name, mark } as Ask].slice(-ASKS_CAP))
  } catch (err) {
    logFault($, `the pending ask could not be recorded (${String(err)})`)
  }
  return {
    decided: { model: '-', effort: '-', by: 'none', reason: `refused, the user is to choose: ${why}` },
    deny: `delegate: no model could classify this agent (${why}). Call AskUserQuestion with two questions, worded exactly: "${modelQuestion(name, mark)}" and "${effortQuestion(name, mark)}" (the mod sets their wording and options itself). Then call Agent again with the same description: the mod applies the model and the effort the user chose, whatever that call names.`,
  }
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

// A pinned call (a fork, a custom type) goes on without the model and effort the caller named: they stay in `asked`.
const unnamed = (e: Call): Call => ({ ...e, model: undefined, effort: undefined })

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
  // The user's answer to the questions a refusal named: seen as the engine returns it, never taken from a later call.
  if (e.tool === 'AskUserQuestion') {
    let sent: object = e
    let clean = false
    let asked: Worded[] = []
    try {
      ;({ input: sent, clean, asked } = await canonical($, e))
    } catch (err) {
      logFault($, `the questions could not be checked (${String(err)}); no answer will be taken`)
    }
    const ran = await next(sent as typeof e)
    try {
      if (clean) await captured($, sent as { questions?: unknown }, asked, ran as { deny?: string; isError?: true; result?: unknown })
    } catch (err) {
      logFault($, `the answer could not be recorded (${String(err)}); the retry will be refused`)
    }
    return ran
  }
  // The Agent call: the mod decides model and effort; what the caller named is kept as `asked`.
  if (e.tool === 'Agent') {
    const asked = { model: e.model, effort: e.effort }
    const keep = pinned(e)
    let r: Resolved
    if (keep) r = { decided: { model: 'inherited', effort: 'default', by: 'caller', reason: 'fork or custom type: its definition or the parent decides; the named pair is only a request' } }
    else {
      try {
        r = await decide($, e)
      } catch (err) {
        // The decision failed (the pending asks could not be read or taken): the user is asked, with a row to show it.
        logFault($, `the decision failed (${String(err)}); the user chooses`)
        r = await askUser($, e, 'the decision failed')
      }
    }
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
    const refuseRow = async (): Promise<void> => {
      try {
        await update($, rows, (list) => list.map((x) => (x.id === entry.id ? { ...x, status: 'refused' as const } : x)))
      } catch (err) {
        // the call already ran: a failure here must not run it again through the fault handler
        logFault($, `the row could not be marked refused (${String(err)})`)
      }
    }
    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(keep ? unnamed(e) : { ...e, model: decided.model as Model, effort: decided.effort as Effort })
    } catch (err) {
      // The layer below failed after the row was written: the row says so and the call is refused here. It is not sent
      // again (it may have started), and the caller's pair never goes through.
      logFault($, `the Agent call failed below the mod (${String(err)}); it was refused`)
      await refuseRow()
      return { deny: 'delegate: the Agent call failed below the mod; this agent was not confirmed started. Call Agent again.' }
    }
    if (ran.deny !== undefined) await refuseRow()
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

// A pending ask, and the answer to it, belong to the turn that asked: the next prompt, or the end of the turn, drops them.
const expireAsks = async ($: Ctx): Promise<void> => {
  try {
    await update($, asks, () => [])
  } catch (err) {
    logFault($, `the pending asks could not be dropped (${String(err)})`)
  }
}

const turned: Hook<'turn.start'> = async ($, e, next) => {
  // Every run starts a turn, a subagent's, a teammate's and the engine's own forks too: only the main loop's ends the ask.
  if (e.agentId !== undefined) return next(e)
  await expireAsks($)
  return next(e)
}

const completed: Hook<'turn.complete'> = async ($, e, next) => {
  if (e.agentId === undefined) await expireAsks($)
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
    // call. Fire and forget (`warm` never rejects and is bounded); a failure is the first classification's to report. While it runs, a spawn is
    // `fm-busy` and does not wait behind it.
    gate.warming = true
    void warm((argv, init) => $.process.run(argv, init), (ms, o) => $.clock.sleep(ms, o))
      .then((failure) => {
        if (failure === 'fm-absent') fmAbsent = true
      })
      .finally(() => {
        gate.warming = false
      })
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
    if (e.tool !== 'Agent' || e.agentId !== undefined) return next(e)
    if (pinned(e)) return next(unnamed(e))
    logFault($, 'the tool.call hook failed; the user chooses')
    // A throw in this handler would leave the call to the engine's own fault path: whatever happens here, it is refused.
    let r: Resolved
    try {
      r = await askUser($, e, 'the tool.call hook failed')
    } catch (err) {
      logFault($, `the user could not be asked (${String(err)}); the agent was refused`)
      return { deny: 'delegate: the tool.call hook failed and the user could not be asked; this agent was not started. Try again.' }
    }
    if (r.deny !== undefined) return { deny: r.deny }
    return next({ ...e, model: r.decided.model as Model, effort: r.decided.effort as Effort })
  })
  on('agent.spawn', spawned).catch(($, e, next) => next(e))
  on('turn.start', turned)
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
