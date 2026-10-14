// Pure text of the PHASES panel and the band: where each loop is, on the eight phases.

import type { LoopPhases, PhasesState } from './deps'

// source: zetetic-autopilot's contract (types/index.d.ts `Phase`), in the order a task runs them.
export const PHASE_ORDER = ['planning', 'analysis', 'design', 'implementation', 'verification', 'test', 'review', 'report'] as const
export type Phase = (typeof PHASE_ORDER)[number]

// Four letters a cell, so the eight phases fit a 40-column strip.
export const ABBREV: Record<Phase, string> = {
  planning: 'plan',
  analysis: 'anly',
  design: 'dsgn',
  implementation: 'impl',
  verification: 'veri',
  test: 'test',
  review: 'revw',
  report: 'rprt',
}

// `claude-opus-5-5` → `opus 5.5`; an alias stays as it is.
export const shortModel = (model: string): string => {
  const m = /claude-([a-z]+)-(\d+)-(\d+)/.exec(model)
  return m === null ? model : `${m[1]} ${m[2]}.${m[3]}`
}

// What a loop is called in a row: main, else the agent type's last segment and its task.
export const loopName = (l: LoopPhases): string =>
  l.type === 'main' ? 'main' : `${l.type.slice(l.type.lastIndexOf(':') + 1)} · ${l.description}`

export type Cell = { label: string; state: 'current' | 'visited' | 'ahead' }

export const strip = (l: LoopPhases): Cell[] => {
  const visited = new Set<string>(l.runs.map((r) => r.phase))
  return PHASE_ORDER.map((p) => ({
    label: ABBREV[p],
    state: l.phase === p ? 'current' : visited.has(p) ? 'visited' : 'ahead',
  }))
}

// The runs in the order they happened: `anly 3 › impl 1 › test 2`.
export const trail = (l: LoopPhases): string =>
  l.runs.map((r) => `${ABBREV[r.phase as Phase] ?? r.phase} ${r.steps}`).join(' › ')

export const running = (s: PhasesState): LoopPhases[] => s.loops.filter((l) => l.status === 'running')

// One line above the prompt: main's phase, the running agents', the advisor this turn.
export const bandText = (s: PhasesState): string | undefined => {
  const main = s.loops.find((l) => l.id === 'main')
  const agents = running(s).filter((l) => l.id !== 'main')
  if (main === undefined && agents.length === 0) return undefined
  const turnCalls = s.advisor.uses.filter((u) => u.turnId === s.turnId).reduce((n, u) => n + u.calls, 0)
  const parts = [
    main === undefined ? 'main starting' : main.status === 'done' ? `main idle (last ${main.phase ?? 'none'})` : `main ${main.phase ?? 'starting'}`,
    ...agents.map((a) => `${a.type.slice(a.type.lastIndexOf(':') + 1)} ${a.phase ?? 'starting'}`),
    `advisor ${turnCalls} this turn`,
  ]
  return `phase · ${parts.join(' · ')}`
}

// The advisor in the session: how many calls, and when they came relative to the turn's writing.
export const advisorText = (s: PhasesState): string => {
  if (s.advisor.session === 0) return 'advisor: not called this session'
  const by = (w: string) => s.advisor.uses.filter((u) => u.when === w).reduce((n, u) => n + u.calls, 0)
  return `advisor: ${s.advisor.session} calls this session · ${by('before-write')} before writing · ${by('after-write')} after · ${by('at-completion')} at completion (last ${s.advisor.uses.length} steps)`
}
