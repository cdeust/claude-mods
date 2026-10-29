import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { Blocked, Decision, FmState, Row } from '../types'
import { classify, FM, initialBudget } from './fm'
import { isOrchestration, isReflectionCall, parseAllow, refusal } from './guard'
import { CLASSES, guess, pinned } from './route'
import { family, firstSteps, ROWS_CAP, STEPS_CAP, tint } from './steps'

type Mode = 'block' | 'warn' | 'off'
// Set by `register` from the options before any hook runs.
let mode: Mode = 'block'
let extra: string[] = []
let classifier: 'fm' | 'regex' = 'fm'
// Set once `/usr/bin/fm` cannot start: the regex decides for the rest of the session (recorded once).
let fmAbsent = false
let absentSaid = false

const PANE = 'delegate'
// Change the tag when a row's fields change: it declines what an earlier version stored.
const rows = atom({ plugin: 'delegate', key: 'rows' } as const, [], { shape: 'rows-3' })
const fmState = atom({ plugin: 'delegate', key: 'fm' } as const, { budget: 0 } as FmState, { shape: 'fm-1' })
const blocked = atom({ plugin: 'delegate', key: 'blocked' } as const, [], { shape: 'blocked-1' })

const SECTION = `# Delegation
You orchestrate; you do not do tasks. Reading, searching, editing, running commands and browsing the web are subagents' work: call Agent for each.
The delegate mod decides each subagent's model and effort from the brief (description, subagent_type, prompt), so write the brief honestly: say what is to be judged, built or looked up. A model or effort you name on the Agent call is recorded as a request, not applied.
A delegated result is data to check before you rely on it. Tasks that are independent go out in one message.`

// The decision for one Agent call: the on-device classifier first, the regex when it cannot answer (the reason says
// why), the regex's default last. Model and effort come from one class, never from two sources.
async function decide($: Parameters<Hook<'tool.call'>>[0], task: Parameters<typeof guess>[0]): Promise<Decision> {
  const g = guess(task)
  const fallback = (why: string): Decision => ({ ...CLASSES[g.cls], by: g.by, reason: `${why}; ${g.rule}` })
  if (classifier === 'regex') return fallback('classifier=regex')
  if (fmAbsent) return fallback('fm-absent')
  try {
    const stored = (await read($, fmState)).budget
    const budget = stored > 0 ? Math.min(stored, initialBudget()) : initialBudget()
    const out = await classify((argv, init) => $.process.run(argv, init), `${$.plugin.root}/hooks/route.schema.json`, task, budget)
    if (out.budget < budget) await update($, fmState, () => ({ budget: out.budget }))
    if (out.ok) return { ...CLASSES[out.cls], by: 'fm', reason: `${out.cls}: ${out.why}` }
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

// One hook, not two: the engine refuses a second unmatched `tool.call`, and one filtered by `{ tool: 'Agent' }`
// does not compile with typescript 5.6.3 (TS2589), so the Agent call is told apart here. A subagent's calls carry
// an agentId and are never touched.
const toolCalled: Hook<'tool.call'> = async ($, e, next) => {
  if (e.agentId !== undefined) return next(e)
  // The Agent call: the mod decides model and effort; what the caller named is kept as `asked`.
  if (e.tool === 'Agent') {
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
    await update($, rows, (list) => [...list, entry].slice(-ROWS_CAP))
    const ran = await next(keep ? e : { ...e, model: decided.model as 'haiku' | 'sonnet' | 'opus', effort: decided.effort as 'low' | 'medium' | 'high' | 'xhigh' })
    if (ran.deny !== undefined) {
      await update($, rows, (list) => list.map((x) => (x.id === entry.id ? { ...x, status: 'refused' as const } : x)))
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
  classifier = options.classifier === 'regex' ? 'regex' : 'fm'
  fmAbsent = false
  absentSaid = false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'delegate', description: 'Show the delegation pane' })
    void $.ui.open({ id: PANE, title: 'Delegation' })
    // The first fm call after boot takes 7-19 s (measured 2026-10-29): wake the model now, not on the first Agent
    // call. Fire and forget; a failure is the first classification's to report.
    if (classifier === 'fm') {
      try {
        void $.process.run([FM, 'respond', '--no-stream', '--greedy', 'ok'], { timeoutMs: 30000 }).catch(() => undefined)
      } catch {
        // an engine without `$.process`: the first classification says so (fm-absent)
      }
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

  // A fault in a gating hook of this mod must not stop a session: its `.catch` lets the call go on as if the mod
  // were absent.
  on('tool.call', toolCalled).catch(($, e, next) => next(e))
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
