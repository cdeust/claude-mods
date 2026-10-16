// Pure side of the phases: which phase a loop (main or a subagent) is in, read off what it does.
// The owner's list (2026-10-14): planning, analysis, design, verification, test, review, report;
// implementation is added for the steps that write code, which none of the seven names.

import type { AdvisorUse, LoopPhases, Phase, PhaseRun, PhasesState } from '../types'

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
// source: Claude Code tool names; the file reads any model can do. Not READING_TOOLS, which also holds
// web and search tools, and not the analysis phase, which also holds delegations, recalls and skills.
export const FILE_READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])

// The one definition of a mechanical step: it calls tools and every call is a file read.
export const isFileReadStep = (uses: readonly { name: string }[]): boolean => uses.length > 0 && uses.every((u) => FILE_READ_TOOLS.has(u.name))

// Each pattern names a command by its head, the first words of a segment (`a && b`, `a; b`, `a | b`),
// so a word inside an argument (`grep pytest`, `git commit -m "fix tsc"`) names nothing.
// An inline check (`python3 -c '...; assert ...'`) carries its own `;`: read on the whole line.
const ASSERT_RUN = /(^|&&\s*)python3? -c .*\bassert\b/
const TEST_RUN = /^(python3? -m (pytest|unittest)|pytest|(npm|pnpm|yarn|bun) (run )?test|claude plugin test|go test|cargo test|(npx (-y )?)?(jest|vitest)|(sh|bash) \S*(mutation_check|reproduce)\S*)/
const CHECK_RUN = /^((uvx )?ruff\S*|(npx (-y )?(-p typescript )?)?tsc|mypy|pyright|(npx (-y )?)?eslint|claude plugin validate|python3? \S*check_craftsmanship|(sh|bash) \S*check-shared|python3? -m mcp_server\.doctor)\b/
const REVIEW_RUN = /^gh pr (review|diff)\b|^gh pr comment\b.*ZETETIC-REVIEW/
const DELIVER_RUN = /^(git (commit|push|tag)|gh pr (create|merge)|gh issue create)\b/
const READ_RUN = /^(ls|cat|head|tail|sed -n|grep|rg|find|wc|git (log|show|status|blame|diff)|gh (pr|issue) (view|list)|which|pwd|echo)\b/
const NEUTRAL_RUN = /^(cd|export|set|source|true)\b/
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

const segmentPhase = (segment: string): Phase | undefined => {
  if (segment === '' || NEUTRAL_RUN.test(segment)) return undefined
  if (REVIEW_RUN.test(segment)) return 'review'
  if (TEST_RUN.test(segment)) return 'test'
  if (CHECK_RUN.test(segment)) return 'verification'
  if (DELIVER_RUN.test(segment)) return 'report'
  return READ_RUN.test(segment) ? 'analysis' : 'implementation'
}

// The first line only (a heredoc's body is data); the furthest phase of its segments.
const bashPhase = (command: string): Phase => {
  const line = command.split('\n')[0] ?? ''
  if (ASSERT_RUN.test(line)) return 'test'
  return line
    .split(/&&|\|\||;|\|/)
    .map((s) => segmentPhase(s.trim().replace(/^([A-Z_]+=\S+\s+)+/, '')))
    .filter((p): p is Phase => p !== undefined)
    .reduce<Phase>((best, p) => (RANK[p] > RANK[best] ? p : best), 'analysis')
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

// Commands that run the repository, the host or the session's worktrees: orchestration, whatever bashPhase
// calls an unrecognised head. A change to a source file is not made by these.
// source: the orchestrator's own first turn (fetch, worktree add, hygiene register-worktree, mkdir)
const PLUMBING_RUN = /^(git|gh|claude|mkdir|rmdir|sleep|python3? \S*disk_hygiene\S*)\b/

// git verbs that rewrite files of the working tree, which the plumbing above does not otherwise do.
// source: git's own manuals for apply, am, restore, clean, mv, rm, cherry-pick, revert, reset --hard, stash pop/apply
// and `checkout [<tree-ish>] -- <path>`; the review's probe P3 (2026-10-16) named apply, checkout -- and reset --hard
const GIT_CHANGE = /^git(\s+-C\s+\S+)?\s+(apply|am|restore|clean|mv|rm|cherry-pick|revert|reset\s+--hard|stash\s+(pop|apply)|checkout\b.*\s--(\s|$))/
// Runs that read or check and write nothing: the repository's own gates (`node --test`, `node <script> --check`),
// jq (it has no in-place mode), and inline Python, unless its code writes (PY_WRITES, read on the quoted text).
const READ_ONLY_RUN = /^(node\b.*\s--(test|check)\b|jq\b)/
const PY_INLINE = /^python3? -c\b/
const PY_WRITES = /\.write(_text|_bytes)?\(|\bopen\([^)]*,\s*['"][wax+]/
// A redirection into a file (`> f`, `>> f`, `&> f`), not into a descriptor (`2>&1`); the target is captured.
const REDIRECT = /(?:^|[^<>&0-9])[0-9]?(?:&>|>>?)\s*([^\s&|;<>]+)/g
// source: own choice, the places a session keeps throwaway output (the null device, the system and session temp dirs)
const SCRATCH = /^(\/dev\/|\/tmp\/|\/private\/tmp\/|\$\{?TMPDIR\b)/

// The lines a command runs: every line, less a heredoc's body (data, up to its terminator).
const runLines = (command: string): string[] => {
  const lines: string[] = []
  let end: string | undefined
  for (const line of command.split('\n')) {
    if (end !== undefined) {
      if (line.trim() === end) end = undefined
      continue
    }
    lines.push(line)
    end = /<<-?\s*['"]?(\w+)['"]?/.exec(line)?.[1]
  }
  return lines
}

// Quoted text is an argument: never a separator, a redirection or a command.
const unquoted = (line: string): string => line.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''")

const segmentChanges = (segment: string, raw: string): boolean => {
  if (GIT_CHANGE.test(segment)) return true
  if (PY_INLINE.test(segment)) return PY_WRITES.test(raw)
  if (PLUMBING_RUN.test(segment) || READ_ONLY_RUN.test(segment)) return false
  return segmentPhase(segment) === 'implementation'
}

const lineChanges = (raw: string): boolean => {
  const line = unquoted(raw)
  if ([...line.matchAll(REDIRECT)].some((m) => !SCRATCH.test(m[1] ?? ''))) return true
  return line
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim().replace(/^([A-Z_]+=\S+\s+)+/, ''))
    .some((s) => s !== '' && segmentChanges(s, raw))
}

// Work the owner's rule hands to a subagent ("aucune tâche ne tourne en session globale"): a file the main
// loop writes (code or test; a document is design, the orchestrator's own), or a shell command that changes
// things, on any of its lines: a redirection into a file, a git verb that rewrites the working tree, or the
// implementation phase of bashPhase less the plumbing and the read-only runs above. Reads, checks, tests and
// delivery are orchestration.
export const isMainImplementation = (name: string, input: unknown): boolean => {
  if (WRITING_TOOLS.has(name)) return toolPhase(name, input) !== 'design'
  if (name !== 'Bash') return false
  return runLines(field(input, 'command')).some(lineChanges)
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

// The runs an agent made before its type was known, as one run of the type's phase. `reads` is the
// sum when every run carries it; a run recorded before it was counted leaves the sum absent.
const merged = (runs: readonly PhaseRun[], phase: Phase, at: number): PhaseRun => ({
  phase,
  effort: runs[runs.length - 1]?.effort ?? null,
  steps: runs.reduce((n, r) => n + r.steps, 0),
  errors: runs.reduce((n, r) => n + r.errors, 0),
  since: runs[0]?.since ?? at,
  ...(runs.every((r) => r.reads !== undefined) ? { reads: runs.reduce((n, r) => n + (r.reads ?? 0), 0) } : {}),
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
      runs: phase === null ? before.runs : [merged(before.runs, phase, a.at)],
    })
  return withLoop(s, {
    id: a.id,
    type: a.type,
    description: a.description,
    model: a.model,
    effort: null,
    phase,
    runs: phase === null ? [] : [{ phase, effort: null, steps: 0, errors: 0, since: a.at, reads: 0 }],
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
  fileRead: boolean // isFileReadStep of the step's tool calls
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
      : last !== undefined && last.phase === phase && last.effort === st.effort
        ? [...loop.runs.slice(0, -1), { ...last, steps: last.steps + 1, ...(last.reads === undefined ? {} : { reads: last.reads + (st.fileRead ? 1 : 0) }) }]
        : [...loop.runs, { phase, effort: st.effort, steps: 1, errors: 0, since: st.at, reads: st.fileRead ? 1 : 0 }]
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

// A tool call of the loop failed or was refused: counted on the run it happened in, the evidence
// the insights mod learns each phase's effort from.
export const erred = (s: PhasesState, loopId: string): PhasesState => {
  const loop = s.loops.find((l) => l.id === loopId)
  const last = loop?.runs[loop.runs.length - 1]
  if (loop === undefined || last === undefined) return s
  return withLoop(s, { ...loop, runs: [...loop.runs.slice(0, -1), { ...last, errors: last.errors + 1 }] })
}

export const finished = (s: PhasesState, loopId: string, at: number): PhasesState => {
  const loop = s.loops.find((l) => l.id === loopId)
  return loop === undefined ? s : withLoop(s, { ...loop, status: 'done', updatedAt: at })
}
