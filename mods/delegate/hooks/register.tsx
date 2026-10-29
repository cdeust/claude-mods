import { atom, read, update } from 'claude-code'
import type { Hook, MatchedHook, Register } from 'claude-code'

import type { Blocked, Decision, Row } from '../types'
import { classify, failureOf, FM, newGate } from './fm'
import { isLedgerCall, isOrchestration, isTranscriptOnDisk, parseAllow, projectsDir, refusal, transcriptsRead } from './guard'
import type { Call } from './guard'
import { bound, CLASSES, guess, pinned } from './route'
import { family, firstSteps, ROWS_CAP, STEPS_CAP, tint } from './steps'

type Mode = 'block' | 'warn' | 'off'
// Set by `register` from the options before any hook runs.
let mode: Mode = 'block'
let extra: string[] = []
let classifier: 'fm' | 'regex' = 'fm'
// Set once `/usr/bin/fm` cannot start: the regex decides for the rest of the session (recorded once).
let fmAbsent = false
let absentSaid = false
// One classification in flight; the model warming up counts as busy (see fm.ts).
let gate = newGate()

const PANE = 'delegate'
// Change the tag when a row's fields change: it declines what an earlier version stored.
const rows = atom({ plugin: 'delegate', key: 'rows' } as const, [], { shape: 'rows-3' })
const blocked = atom({ plugin: 'delegate', key: 'blocked' } as const, [], { shape: 'blocked-1' })

const SECTION = `# Delegation
You orchestrate; you do not do tasks. Reading, searching, editing, running commands and browsing the web are subagents' work: call Agent for each.
The delegate mod decides each subagent's model and effort from the brief (description, subagent_type, prompt), so write the brief honestly: say what is to be judged, built or looked up. A model or effort you name on the Agent call is recorded as a request, not applied.
A delegated result is data to check before you rely on it. Tasks that are independent go out in one message.`

// The decision for one Agent call: the on-device classifier first, the regex when it cannot answer (the reason says
// why), the regex's default last. Model and effort come from one class, never from two sources.
async function decide($: Parameters<Hook<'tool.call'>>[0], task: Parameters<typeof guess>[0]): Promise<Decision> {
  const g = guess(task)
  // The keyword answer obeys the same bounds (an Explore told to audit is judge, not read).
  const bounded = bound(g.cls, task)
  const fallback = (why: string): Decision => ({
    ...CLASSES[bounded.cls],
    by: g.by,
    reason: `${why}; ${g.rule}${bounded.note === undefined ? '' : ` [${bounded.note}: keywords said ${g.cls}]`}`,
  })
  if (classifier === 'regex') return fallback('classifier=regex')
  if (fmAbsent) return fallback('fm-absent')
  try {
    const out = await classify(gate, (argv, init) => $.process.run(argv, init), `${$.plugin.root}/hooks/route.schema.json`, task)
    if (out.ok) {
      // The model's class is bounded by deterministic evidence; a bound that changed the answer is recorded.
      const b = bound(out.cls, task)
      const note = b.note === undefined ? '' : ` [${b.note}: model said ${out.cls}]`
      return { ...CLASSES[b.cls], by: 'fm', reason: `${b.cls}: ${out.why}${note}` }
    }
    if (out.failure === 'fm-absent') fmAbsent = true
    return fallback(out.failure)
  } catch {
    return fallback('fm-error')
  }
}

// What the caller named, when the mod decided otherwise: the disagreement the pane keeps visible.
const askedNote = (x: Row): string => {
  const { model, effort } = x.asked
  if ((model === undefined && effort === undefined) || (model === x.decided.model && effort === x.decided.effort)) return ''
  return ` (asked ${model ?? '-'}/${effort ?? '-'})`
}

const logFault = ($: Parameters<Hook<'tool.call'>>[0], text: string): void => {
  try {
    $.ui.log(`delegate: ${text}`, { to: 'debug' })
  } catch {
    // nowhere left to say it
  }
}

type Dollar = Parameters<Hook<'tool.call'>>[0]
type ToolCall = Parameters<Hook<'tool.call'>>[1]
type Next = Parameters<Hook<'tool.call'>>[2]

// The Stop reflection hook's four calls (a ledger lift or list; a Read or a grep of subagent transcripts): the
// shapes are guard.ts's. A transcript must also be, under the real HOME, a regular file where its path says.
// Anything that faults (HOME unset, a stat refused or missing) refuses here, since this hook's .catch fails open.
async function isReflectionOnDisk($: Dollar, call: Call): Promise<boolean> {
  if (isLedgerCall(call)) return true
  try {
    const home = await $.env.get('HOME')
    const paths = transcriptsRead(call, home)
    if (paths === undefined || home === undefined) return false
    const projects = await $.fs.stat(projectsDir(home), { resolve: true })
    for (const path of paths) {
      if (!isTranscriptOnDisk(await $.fs.stat(path, { resolve: true }), projects, path, home)) return false
    }
    return true
  } catch {
    return false
  }
}

// The Agent call: the mod decides model and effort; what the caller named is kept as `asked`.
async function agentCalled($: Dollar, e: ToolCall & { tool: 'Agent' }, next: Next) {
  const asked = { model: e.model, effort: e.effort }
  const keep = pinned(e)
  const decided: Decision = keep
    ? { model: e.model ?? 'inherited', effort: e.effort ?? 'default', by: 'caller', reason: 'fork or custom type: not decided by the mod' }
    : await decide($, e)
  if (fmAbsent && !absentSaid) {
    absentSaid = true
    try {
      $.ui.log(`delegate: ${FM} cannot start; the regex decides for this session`, { to: 'debug' })
    } catch {
      // the record is in each row's reason
    }
  }
  const entry: Row = {
    id: e.tool_use_id,
    description: e.description,
    type: e.subagent_type ?? 'general-purpose',
    model: decided.model,
    effort: decided.effort,
    asked,
    decided,
    status: 'running',
  }
  // Recording the row is not the decision: if it fails, the decided pair still applies and the failure is logged.
  try {
    await update($, rows, (list) => [...list, entry].slice(-ROWS_CAP))
  } catch (err) {
    logFault($, `the row could not be recorded (${String(err)}); the decision still applies`)
  }
  const ran = await next(keep ? e : { ...e, model: decided.model as 'haiku' | 'sonnet' | 'opus', effort: decided.effort as 'low' | 'medium' | 'high' | 'xhigh' })
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

// One hook, not two: the engine refuses a second unmatched `tool.call`, and one filtered by `{ tool: 'Agent' }`
// does not compile with typescript 5.6.3 (TS2589), so the Agent call is told apart here. A subagent's calls carry
// an agentId and are never touched.
const toolCalled: Hook<'tool.call'> = async ($, e, next) => {
  if (e.agentId !== undefined) return next(e)
  if (e.tool === 'Agent') return agentCalled($, e, next)
  if (mode === 'off' || isOrchestration(e.tool, extra)) return next(e)
  if (await isReflectionOnDisk($, e as unknown as Call)) return next(e)
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

const sessionStarted: Hook<'session.start'> = async ($, e, next) => {
  await $.command.register({ name: 'delegate', description: 'Show the delegation pane' })
  void $.ui.open({ id: PANE, title: 'Delegation' })
  // The first fm call after boot takes 7-19 s (measured 2026-10-29): wake the model now, not on the first Agent
  // call. Fire and forget; a failure is the first classification's to report.
  // While it runs, a spawn is `fm-busy` and does not wait behind it.
  if (classifier === 'fm') {
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
  }
  return next(e)
}

// The pane: one line per delegation, `asked → ran` for the model and for the effort (`?` until a step is seen).
const PANE_RENDER = { component: 'Pane', requestId: PANE } as const
const rendered: MatchedHook<'ui.render', typeof PANE_RENDER> = async ($, e) => {
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
}

export const register: Register = (on, options) => {
  mode = options.main_mode === 'warn' || options.main_mode === 'off' ? options.main_mode : 'block'
  extra = parseAllow(typeof options.main_allow === 'string' ? options.main_allow : '')
  classifier = options.classifier === 'regex' ? 'regex' : 'fm'
  fmAbsent = false
  absentSaid = false
  gate = newGate()

  on('session.start', sessionStarted)

  on('command.run', { command: 'delegate' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'Delegation' })
    return { text: 'Delegation pane opened.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    if (mode === 'off') return out
    return { sections: [...out.sections, { id: 'delegate:rules', text: SECTION, scope: 'session' as const }] }
  })

  // A fault in a gating hook of this mod must not stop a session: its `.catch` lets the call go on as if the mod
  // were absent.
  // A fault in the hook itself (after the decision, say) must not hand the call back with the caller's pair: an
  // Agent call that the mod decides still gets the deterministic pair, and the fault is logged.
  on('tool.call', toolCalled).catch(($, e, next) => {
    if (e.tool !== 'Agent' || e.agentId !== undefined || pinned(e)) return next(e)
    const pair = CLASSES[guess(e).cls]
    logFault($, 'the tool.call hook failed; the keyword pair applies')
    return next({ ...e, model: pair.model, effort: pair.effort })
  })
  on('agent.spawn', spawned).catch(($, e, next) => next(e))
  on('turn.step', stepped)
  on('turn.complete', completed)
  on('ui.render', PANE_RENDER, rendered)
}
