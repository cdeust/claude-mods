// Pure side of the phases: which phase a loop (main or a subagent) is in, read off what it does.
// The owner's list (2026-10-14): planning, analysis, design, verification, test, review, report;
// implementation is added for the steps that write code, which none of the seven names.

import type { AdvisorUse, LoopPhases, Phase, PhasesState } from '../types'

export const PHASES: readonly Phase[] = [
  'planning',
  'analysis',
  'design',
  'implementation',
  'verification',
  'test',
  'review',
  'report',
]

// source: ~/.claude/plugins/.../zetetic-team-subagents/commands/zetetic/engineering-loop.md, its
// nine steps; the cycle ledger records these, the view shows the phases (reconcilable both ways).
export const ENGINEERING_LOOP: Record<string, Phase> = {
  check: 'planning',
  recall: 'analysis',
  refine: 'planning',
  investigate: 'analysis',
  implement: 'implementation',
  verify: 'verification',
  benchmark: 'test',
  review: 'review',
  remember: 'report',
}

// When one step does several things, the phase it is in is the furthest along this order.
const RANK: Record<Phase, number> = {
  analysis: 0,
  planning: 1,
  design: 2,
  implementation: 3,
  verification: 4,
  test: 5,
  review: 6,
  report: 7,
}

// An agent type's own phase, from its role (the zetetic agents' descriptions); a type not listed
// is placed by what it does, step by step.
const BY_TYPE: [RegExp, Phase][] = [
  [/(^|:)(Plan|orchestrator|dispatch)$/, 'planning'],
  [/(^|:)(Explore|git-historian|research-scientist|data-scientist|professor)$/, 'analysis'],
  [/(^|:)(architect|ux-designer)$/, 'design'],
  [/(^|:)(test-engineer|experiment-runner)$/, 'test'],
  [/(^|:)(code-reviewer|security-auditor|reviewer-academic|advisor)$/, 'review'],
  [/(^|:)(memory-writer)$/, 'report'],
  [/(^|:)(engineer|frontend-engineer|refactorer|simplifier|dba|devops-engineer|mlops|latex-engineer|paper-writer)$/, 'implementation'],
]

export const typePhase = (type: string): Phase | undefined => BY_TYPE.find(([re]) => re.test(type))?.[1]

const PLANNING_TOOLS = new Set(['EnterPlanMode', 'ExitPlanMode', 'TaskCreate', 'TaskUpdate', 'TodoWrite'])
const READING_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'LSP', 'ToolSearch'])
const WRITING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

const TEST_RUN = /\bpython3? -c .*\bassert\b|\b(pytest|unittest|(npm|pnpm|yarn|bun) (run )?test|claude plugin test|go test|cargo test|jest|vitest|mutation_check|reproduce\.sh)\b/
const CHECK_RUN = /\b(ruff|tsc|mypy|pyright|eslint|claude plugin validate|check_craftsmanship|check-shared|doctor|git diff)\b/
const REVIEW_RUN = /\bgh pr (review|diff)\b|ZETETIC-REVIEW/
const DELIVER_RUN = /\b(git (commit|push|tag)|gh pr (create|merge)|gh issue create)\b/
const READ_RUN = /^\s*(ls|cat|head|tail|sed -n|grep|rg|find|wc|git (log|show|status|blame)|gh (pr|issue) (view|list)|which|pwd|echo)\b/
const DESIGN_FILE = /(^|\/)(docs\/adr\/|wiki\/|design\/)|ADR-\d|\.(md|tex)$/
const TEST_FILE = /(^|\/)(tests?|tests_py|__tests__)\/|\.(test|spec)\.[a-z]+$|_test\.[a-z]+$/

const SKILLS: [RegExp, Phase][] = [
  [/brainstorm|writing-plans|plan$/, 'planning'],
  [/debugging|understand-codebase|recall|research/, 'analysis'],
  [/design|architecture|adr|wiki-author/, 'design'],
  [/test-driven|testing/, 'test'],
  [/verif|integrity|provenance/, 'verification'],
  [/review/, 'review'],
]

const CORTEX = /^mcp__plugin_hypermnesia-mcp_cortex__/
const ARCH = /^mcp__plugin_ai-architect-mcp-codebase_ai-architect__/
const PRD = /^mcp__plugin_ai-architect-mcp-spec_prd-gen__/

const field = (input: unknown, name: string): string => {
  const v = (input as Record<string, unknown> | null)?.[name]
  return typeof v === 'string' ? v : ''
}

const bashPhase = (command: string): Phase => {
  if (REVIEW_RUN.test(command)) return 'review'
  if (TEST_RUN.test(command)) return 'test'
  if (CHECK_RUN.test(command)) return 'verification'
  if (DELIVER_RUN.test(command)) return 'report'
  return READ_RUN.test(command) ? 'analysis' : 'implementation'
}

const mcpPhase = (name: string): Phase | undefined => {
  if (CORTEX.test(name)) {
    if (/__(remember|checkpoint|record_session_end)$/.test(name)) return 'report'
    if (/__wiki_(write|adr)$/.test(name)) return 'design'
    return 'analysis'
  }
  if (PRD.test(name)) return /validate|verification/.test(name) ? 'verification' : 'design'
  if (ARCH.test(name)) return /verif|gates|semantic_diff|validate/.test(name) ? 'verification' : 'analysis'
  return undefined
}

// The phase one tool call puts its loop in; undefined when the call says nothing about it.
export const toolPhase = (name: string, input: unknown): Phase | undefined => {
  if (PLANNING_TOOLS.has(name)) return 'planning'
  if (READING_TOOLS.has(name)) return 'analysis'
  if (WRITING_TOOLS.has(name)) {
    const path = field(input, 'file_path') || field(input, 'notebook_path')
    if (TEST_FILE.test(path)) return 'test'
    return DESIGN_FILE.test(path) ? 'design' : 'implementation'
  }
  if (name === 'Bash') return bashPhase(field(input, 'command'))
  if (name === 'Agent') return typePhase(field(input, 'subagent_type'))
  if (name === 'Skill') return SKILLS.find(([re]) => re.test(field(input, 'skill')))?.[1]
  return mcpPhase(name)
}

// A step's phase: the furthest along of its calls; a step that calls nothing and answers is the
// report. Undefined when nothing in it names a phase (the loop stays where it was).
export const stepPhase = (uses: readonly { name: string; input: unknown }[], answer: string): Phase | undefined => {
  if (uses.length === 0) return answer.trim() === '' ? undefined : 'report'
  return uses
    .map((u) => toolPhase(u.name, u.input))
    .filter((p): p is Phase => p !== undefined)
    .reduce<Phase | undefined>((best, p) => (best === undefined || RANK[p] > RANK[best] ? p : best), undefined)
}

export const LOOPS_CAP = 12 // source: own choice, the running agents and the last few done fit one pane

export const emptyPhases = (): PhasesState => ({ turnId: null, loops: [], advisor: { session: 0, uses: [] } })

// A loop keeps its place in the list; a new one goes last, the oldest finished ones make room.
const withLoop = (s: PhasesState, loop: LoopPhases): PhasesState => {
  if (s.loops.some((l) => l.id === loop.id)) return { ...s, loops: s.loops.map((l) => (l.id === loop.id ? loop : l)) }
  const loops = [...s.loops, loop]
  let excess = loops.length - LOOPS_CAP
  return {
    ...s,
    loops: loops.filter((l) => {
      if (excess <= 0 || l.status !== 'done' || l.id === 'main') return true
      excess -= 1
      return false
    }),
  }
}

// Main's row, reset at each turn: its phases are the turn's.
export const startTurn = (s: PhasesState, turnId: string, model: string, at: number): PhasesState =>
  withLoop({ ...s, turnId }, {
    id: 'main',
    type: 'main',
    description: 'main loop',
    model,
    effort: null,
    phase: null,
    runs: [],
    status: 'running',
    advisorCalls: 0,
    wrote: false,
    updatedAt: at,
  })

// A started subagent's row. Its steps may come in before the spawn answers (the engine runs the
// loop meanwhile): a row they opened is completed here, its runs and status kept.
export const spawned = (
  s: PhasesState,
  a: { id: string; type: string; description: string; model: string; at: number },
): PhasesState => {
  const phase = typePhase(a.type) ?? null
  const before = s.loops.find((l) => l.id === a.id)
  if (before !== undefined)
    return withLoop(s, {
      ...before,
      type: a.type,
      description: a.description,
      phase: phase ?? before.phase,
      runs: phase === null ? before.runs : [{ phase, steps: before.runs.reduce((n, r) => n + r.steps, 0), since: before.runs[0]?.since ?? a.at }],
    })
  return withLoop(s, {
    id: a.id,
    type: a.type,
    description: a.description,
    model: a.model,
    effort: null,
    phase,
    runs: phase === null ? [] : [{ phase, steps: 0, since: a.at }],
    status: 'running',
    advisorCalls: 0,
    wrote: false,
    updatedAt: a.at,
  })
}

const opened = (st: Step): LoopPhases => ({
  id: st.loopId,
  type: st.loopId === 'main' ? 'main' : 'agent',
  description: st.loopId === 'main' ? 'main loop' : 'subagent',
  model: st.model,
  effort: st.effort,
  phase: null,
  runs: [],
  status: 'running',
  advisorCalls: 0,
  wrote: false,
  updatedAt: st.at,
})

export type Step = {
  loopId: string
  model: string
  effort: string | null
  phase: Phase | undefined
  advisorCalls: number
  at: number
}

// An agent whose type names a phase stays in it (a reviewer reading files is still reviewing);
// main and an unplaced type move with what each step does.
export const stepped = (s: PhasesState, st: Step): PhasesState => {
  const loop = s.loops.find((l) => l.id === st.loopId) ?? opened(st)
  const fixed = loop.type !== 'main' && typePhase(loop.type) !== undefined
  const phase = fixed ? loop.phase : (st.phase ?? loop.phase)
  const last = loop.runs[loop.runs.length - 1]
  const runs =
    phase === null
      ? loop.runs
      : last !== undefined && last.phase === phase
        ? [...loop.runs.slice(0, -1), { ...last, steps: last.steps + 1 }]
        : [...loop.runs, { phase, steps: 1, since: st.at }]
  const advisor = loop.type === 'main' && st.advisorCalls > 0 ? adviced(s.advisor, s.turnId, loop, st) : s.advisor
  return {
    ...withLoop(s, {
      ...loop,
      model: st.model,
      effort: st.effort,
      phase,
      runs,
      advisorCalls: loop.advisorCalls + st.advisorCalls,
      wrote: loop.wrote || st.phase === 'implementation' || st.phase === 'design' || st.phase === 'test',
      updatedAt: st.at,
    }),
    advisor,
  }
}

export const USES_CAP = 20 // source: own choice, the pane lists the last advisor calls only

// The advisor (a server tool of the main loop) is counted with when it was called: before the
// turn wrote anything, after, or in the step that answered.
const adviced = (a: PhasesState['advisor'], turnId: string | null, loop: LoopPhases, st: Step): PhasesState['advisor'] => {
  const when: AdvisorUse['when'] = st.phase === 'report' ? 'at-completion' : loop.wrote ? 'after-write' : 'before-write'
  const use: AdvisorUse = { at: st.at, turnId, phase: loop.phase, when, calls: st.advisorCalls }
  return { session: a.session + st.advisorCalls, uses: [...a.uses, use].slice(-USES_CAP) }
}

export const finished = (s: PhasesState, loopId: string, at: number): PhasesState => {
  const loop = s.loops.find((l) => l.id === loopId)
  return loop === undefined ? s : withLoop(s, { ...loop, status: 'done', updatedAt: at })
}
