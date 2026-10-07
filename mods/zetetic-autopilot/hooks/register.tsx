import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ContextHealth, PolicyDecision, PolicyState } from '../types'
import { THRESHOLDS_PATH, band, crossed, matchThresholds, serversOf } from './context'
import {
  CHARS_PER_TOKEN,
  LEAN_TOOLS,
  STUCK_ERRORS,
  currentEffort,
  effortFor,
  escalate,
  group,
  leanText,
  pressureOf,
  resultText,
} from './policy'
import { type TaskClass, mainModelFor, routeAgentModel } from './route'

const DECISIONS_CAP = 50 // source: bounds $.state size; a viewer shows the last rows only

const context = atom({ plugin: 'zetetic-autopilot', key: 'context' } as const, null as ContextHealth | null)
const policy = atom({ plugin: 'zetetic-autopilot', key: 'policy' } as const, {
  mode: 'observe',
  pressure: 'none',
  quotaPercent: 80,
  resultCapChars: 16000,
  decisions: [],
  charsCut: 0,
  errorsInRow: 0,
} as PolicyState)

// The classifier's verdict is zetetic-genius's state (a dependency): read, never written here.
const geniusState = { plugin: 'zetetic-genius', key: 'state' } as const
type Grade = { turnId: string | null; taskClass: TaskClass; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }

const decide = (p: PolicyState, d: PolicyDecision, charsCut = 0): PolicyState => ({
  ...p,
  decisions: [...p.decisions, d].slice(-DECISIONS_CAP),
  charsCut: p.charsCut + charsCut,
})

const expandHome = async ($: EngineInterface, path: string): Promise<string> =>
  path.startsWith('~/') ? `${(await $.env.get('HOME')) ?? ''}/${path.slice(2)}` : path

// The current grade, when the genius mod is loaded and has one bound to a turn.
async function gradeOf($: EngineInterface): Promise<Grade | undefined> {
  try {
    const { value } = await $.state.get(geniusState)
    const c = value?.classified
    return c === null || c === undefined ? undefined : { turnId: c.turnId, taskClass: c.taskClass, effort: c.effort }
  } catch {
    return undefined
  }
}

type Measured = {
  context: {
    tokens?: number
    window: number
    percent?: number
    breakdown?: {
      categories: readonly { name: string; tokens: number }[]
      mcpTools: readonly { serverName: string; tokens: number }[]
    }
  }
  rateLimits: readonly { kind: string; percentUsed: number }[]
  cost?: { usd: number }
}

// A measure carries no breakdown; the one read before is kept until the next full read.
async function readContext($: EngineInterface, m: Measured, before: ContextHealth | null): Promise<ContextHealth> {
  const model = await $.session.model()
  let warn: number | null = null
  let hard: number | null = null
  let source = `${THRESHOLDS_PATH} absent`
  try {
    const t = matchThresholds(await $.fs.read(await expandHome($, THRESHOLDS_PATH)), model)
    if (t !== undefined) {
      warn = t.warn
      hard = t.hard
      source = THRESHOLDS_PATH
    } else source = `${THRESHOLDS_PATH} has no match for ${model}`
  } catch {
    // The file is the Stop guard's; absent means no thresholds, which a viewer says.
  }
  const reading = { tokens: m.context.tokens ?? null, warn, hard }
  return {
    ...reading,
    window: m.context.window,
    percent: m.context.percent ?? null,
    model,
    thresholdsSource: source,
    rateLimits: m.rateLimits.map((r) => ({ kind: r.kind, percentUsed: r.percentUsed })),
    usd: m.cost?.usd ?? null,
    categories:
      m.context.breakdown?.categories.map((c) => ({ name: c.name, tokens: c.tokens })) ?? before?.categories ?? [],
    mcpServers: m.context.breakdown === undefined ? (before?.mcpServers ?? []) : serversOf(m.context.breakdown.mcpTools),
    band: band(reading),
    readAt: await $.clock.now(),
  }
}

// The full read, with the window broken down as /context does it: at start.
async function refreshContext($: EngineInterface): Promise<void> {
  const before = await read($, context)
  const after = await readContext($, await $.session.usage({ breakdown: 'summary' }), before)
  await update($, context, () => after)
}

export const register: Register = (on, options) => {
  const mode: PolicyState['mode'] = options.policy_mode === 'enforce' ? 'enforce' : 'observe'
  const quotaPercent = Number(options.quota_pressure_percent ?? 80)
  const resultCapChars = Number(options.result_cap_chars ?? 16000)
  // A hot reload keeps $.state from the previous load: the configured fields are set afresh.
  const configured = (p: PolicyState): PolicyState => ({ ...p, mode, quotaPercent, resultCapChars })

  on('session.start', async ($, e, next) => {
    await update($, policy, configured)
    await refreshContext($)

    return next(e)
  })

  // /clear, /resume and /branch reset $.state and never fire session.start again.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await update($, policy, configured)
    await refreshContext($)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const before = await read($, context)
    const after = await readContext($, e, before)
    await update($, context, () => after)
    const pressure = pressureOf(after.rateLimits, quotaPercent, after.band)
    await update($, policy, (p) => ({ ...p, pressure }))
    const crossing = crossed(before, after)
    if (crossing !== undefined)
      $.ui.toast(
        `context ${crossing}: ${group(after.tokens ?? 0)} tokens, the Stop guard will ${
          crossing === 'hard' ? 'block the stop' : 'ask for a checkpoint'
        }`,
      )

    return next(e)
  })

  // The effort ladder from the graded rung, the stuck escalation, and main's model under
  // quota: observed, or applied under enforce. A generator, as the event streams.
  on('turn.step', async function* ($, e, next) {
    const p = await read($, policy)
    const isMain = e.agentId === undefined
    const grade = isMain ? await gradeOf($) : undefined
    const g = grade !== undefined && grade.turnId === e.turnId ? grade : undefined
    const have = currentEffort(e.model, e.effort)
    let target = effortFor(e.model, e.index, e.effort, p.pressure, g?.effort) ?? have
    let kind: PolicyDecision['kind'] = 'effort'
    if (isMain && p.errorsInRow >= STUCK_ERRORS) {
      const raised = escalate(target)
      if (raised !== target) {
        target = raised
        kind = 'stuck'
      }
      await update($, policy, (s) => ({ ...s, errorsInRow: 0 }))
    }
    const model = isMain ? mainModelFor(e.model, p.pressure) : undefined
    if (target === have && model === undefined) return yield* next(e)
    const applied = p.mode === 'enforce'
    const at = await $.clock.now()
    const who = `${isMain ? 'main' : 'agent'} step ${e.index} (${e.model})`
    if (target !== have) {
      const subject = g !== undefined && e.index === 0 ? `${who} · ${g.taskClass}` : who
      await update($, policy, (s) => decide(s, { at, kind, subject, from: String(e.effort ?? 'default'), to: target, applied }))
    }
    if (model !== undefined && e.index === 0)
      await update($, policy, (s) =>
        decide(s, { at, kind: 'model', subject: 'main · quota pressure', from: e.model, to: model, applied }),
      )
    if (!applied) return yield* next(e)
    return yield* next({
      ...e,
      ...(target !== have ? { effort: target } : {}),
      ...(model !== undefined ? { model } : {}),
    })
  })

  // Subagents: the family the type and the turn's class call for, one notch down under pressure.
  on('agent.spawn', async ($, e, next) => {
    const p = await read($, policy)
    const grade = e.parentAgentId === undefined ? await gradeOf($) : undefined
    const cls = grade !== undefined && grade.turnId !== null ? grade.taskClass : undefined
    const target = routeAgentModel(e.subagentType, e.model, e.parentModel, p.pressure, cls)
    if (target === undefined) return next(e)
    const applied = p.mode === 'enforce'
    const d: PolicyDecision = {
      at: await $.clock.now(),
      kind: 'model',
      subject: `${e.subagentType}${cls === undefined ? '' : ` · ${cls}`}`,
      from: e.model ?? `inherit ${e.parentModel}`,
      to: target,
      applied,
    }
    await update($, policy, (s) => decide(s, d))
    return next(applied ? { ...e, model: target } : e)
  })

  // The stuck signal: main's tool errors in a row, read by the next turn.step.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if ((e as { agentId?: string }).agentId === undefined) {
      const isBlocked = ran.deny !== undefined || ran.isError === true
      await update($, policy, (s) => ({ ...s, errorsInRow: isBlocked ? s.errorsInRow + 1 : 0 }))
    }

    return ran
  })

  // Memory leaning: a streaming tool's long result keeps head and tail before it is stored.
  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    const tool = e.origin.kind === 'tool' ? e.origin.tool : undefined
    if (tool === undefined || !LEAN_TOOLS.has(tool)) return next(e)
    const p = await read($, policy)
    let cut = 0
    const content = e.message.content.map((block) => {
      if (block.type !== 'tool_result') return block
      const text = resultText(block.content)
      if (text === undefined) return block
      const lean = leanText(text, p.resultCapChars)
      if (lean === undefined) return block
      cut += lean.cut
      if (p.mode !== 'enforce') return block
      return typeof block.content === 'string'
        ? { ...block, content: lean.text }
        : { ...block, content: [{ type: 'text', text: lean.text }] }
    })
    if (cut === 0) return next(e)
    const applied = p.mode === 'enforce'
    const d: PolicyDecision = {
      at: await $.clock.now(),
      kind: 'lean',
      subject: tool,
      from: `${group(cut)} chars`,
      to: `about ${group(Math.round(cut / CHARS_PER_TOKEN))} tokens kept out`,
      applied,
    }
    await update($, policy, (s) => decide(s, d, applied ? cut : 0))
    return next({ ...e, message: { ...e.message, content } })
  })

  // The stuck counter is a turn's own; main's ends with its turn.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await update($, policy, (s) => ({ ...s, errorsInRow: 0 }))

    return next(e)
  })
}
