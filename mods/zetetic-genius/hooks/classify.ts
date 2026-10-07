// Pure half of the request classifier: what the cheap model is asked, how its answer is read,
// and what each answer means for effort. The two option lists come from files read at start.

import type { Classified, Effort, GeniusPick, TaskClass } from '../types'
import type { GeniusRow } from './genius'

// source: ~/.claude/reference/skill-routing-table.md, generated from the problem-shaped skills'
// `shapes:` frontmatter (zetetic-team-subagents); read at session start, never copied here.
export const SHAPES_PATH = '~/.claude/reference/skill-routing-table.md'
// source: the skills are installed under this plugin name (the Skill tool lists them so).
export const SHAPE_SKILL_PREFIX = 'zetetic-team-subagents:'

export type Shape = { id: string; description: string }

// `| shape | skill | description |` rows; the header and the separator carry no shape.
export const parseShapes = (table: string): Shape[] =>
  table
    .split('\n')
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 4 && /^[a-z][a-z-]+$/.test(cells[1] ?? ''))
    .map((cells) => ({ id: cells[1] ?? '', description: (cells[3] ?? '').replace(/\s+/g, ' ') }))

// source: effort-calibration.md task table: reading and I/O low; a fully specified plan low; a
// clear bug fix low–medium (medium here, the higher bound); architecture, PRD, research
// synthesis medium; correctness-critical work high; "genuinely stuck" high is the autopilot's
// stuck signal, not the classifier's.
export const TASK_CLASSES: readonly TaskClass[] = ['routine', 'planned', 'bugfix', 'analysis', 'critical']
const CLASS_EFFORT: Record<TaskClass, Effort> = {
  routine: 'low',
  planned: 'low',
  bugfix: 'medium',
  analysis: 'medium',
  critical: 'high',
}
export const effortForClass = (cls: TaskClass): Effort => CLASS_EFFORT[cls]

export type Classification = { taskClass: TaskClass; shapes: string[]; geniuses: GeniusPick[] }

// source: own choice, under this length the text continues the previous task ("yes", "go on")
// and carries no shape of its own.
export const MIN_CLASSIFIABLE_CHARS = 20
// source: own choice, the opening of a request names its task; the rest is pasted material.
export const PROMPT_HEAD_CHARS = 4000
export const MAX_PICKS = 2 // source: /genius:route recommends 1–3 agents; two patterns at most per prompt

// A slash command runs through command.run; a plugin's own submit is not the person's request.
export const isClassifiable = (text: string, origin: { kind: string }): boolean =>
  origin.kind !== 'plugin' && !text.trimStart().startsWith('/') && text.trim().length >= MIN_CLASSIFIABLE_CHARS

export const classifierSystem = (shapes: readonly Shape[], genius: readonly GeniusRow[]): string =>
  [
    'You classify one request addressed to a coding agent. Answer with one JSON object and nothing else:',
    '{"task_class": <class>, "shapes": [<skill id>, ...], "geniuses": [{"agent": <agent>, "shape": <shape>}, ...]}',
    '',
    'task_class is exactly one of:',
    '- routine: reading, listing, searching, formatting, a one-line change, a question answered from files.',
    '- planned: implementing a plan or spec that is already written out in the request.',
    '- bugfix: a bug whose cause is clear or quickly located.',
    '- analysis: an architecture decision, a design, a research synthesis, a multi-file feature.',
    '- critical: formal correctness, concurrency, security, billing, data loss; a wrong answer is worse than a slow one.',
    '',
    `shapes and geniuses together hold at most ${MAX_PICKS} picks whose trigger the request clearly matches; both [] when none does.`,
    // source: agents/genius/INDEX.md, its rule, verbatim.
    'Rule: if no shape below matches the problem, do not force a genius agent.',
    'A pick fits only when the request has that structure, never because the topic is adjacent.',
    'Prefer a genius shape (a precise reasoning procedure) over a skill when both would fit; never pick both for the same structure.',
    '',
    'Skills (problem-shaped methods):',
    ...shapes.map((s) => `- ${s.id}: ${s.description}`),
    '',
    'Genius shapes (agent in parentheses, then the trigger):',
    ...genius.map((g) => `- ${g.shape} (${g.agent}): ${g.trigger}`),
  ].join('\n')

export const classifierPrompt = (text: string): string => text.slice(0, PROMPT_HEAD_CHARS)

const asPick = (v: unknown, known: readonly GeniusRow[]): GeniusPick | undefined => {
  const o = v as { agent?: unknown; shape?: unknown } | null
  if (o === null || typeof o !== 'object' || typeof o.agent !== 'string' || typeof o.shape !== 'string') return undefined
  return known.some((g) => g.agent === o.agent && g.shape === o.shape) ? { agent: o.agent, shape: o.shape } : undefined
}

// Strict: a JSON object, fenced or bare; an unknown class, skill or genius pair voids the answer.
export const parseClassification = (
  answer: string,
  shapes: readonly Shape[],
  genius: readonly GeniusRow[],
): Classification | undefined => {
  const match = /\{[\s\S]*\}/.exec(answer)
  if (match === null) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(match[0])
  } catch {
    return undefined
  }
  const obj = raw as { task_class?: unknown; shapes?: unknown; geniuses?: unknown }
  const cls = obj.task_class
  if (typeof cls !== 'string' || !(TASK_CLASSES as readonly string[]).includes(cls)) return undefined
  const knownSkills = new Set(shapes.map((s) => s.id))
  const skills = Array.isArray(obj.shapes) ? obj.shapes : []
  if (!skills.every((s) => typeof s === 'string' && knownSkills.has(s))) return undefined
  const picks = Array.isArray(obj.geniuses) ? obj.geniuses.map((g) => asPick(g, genius)) : []
  if (picks.some((p) => p === undefined)) return undefined
  const geniuses = (picks as GeniusPick[]).filter((p, i, all) => all.findIndex((q) => q.agent === p.agent) === i)
  const uniqueSkills = [...new Set(skills as string[])]
  const room = Math.max(0, MAX_PICKS - geniuses.slice(0, MAX_PICKS).length)
  return { taskClass: cls as TaskClass, shapes: uniqueSkills.slice(0, room), geniuses: geniuses.slice(0, MAX_PICKS) }
}

export const toClassified = (c: Classification, text: string, startedAt: number, now: number): Classified => ({
  turnId: null,
  text,
  taskClass: c.taskClass,
  effort: effortForClass(c.taskClass),
  shapes: c.shapes,
  geniuses: c.geniuses,
  ms: now - startedAt,
  at: now,
})

// What the model reads beside the prompt when a skill fits: load it first.
export const shapeContext = (ids: readonly string[]): string =>
  [
    'zetetic-genius: this request matches a reasoning shape. Before answering, invoke the Skill tool for',
    ...ids.map((id) => `  ${SHAPE_SKILL_PREFIX}${id}`),
    'and follow its method. Say in one line which shape you applied.',
  ].join('\n')

// source: own choice, the opening of a prompt identifies it at turn.start.
export const BIND_HEAD_CHARS = 200
export const sameRequest = (a: string, b: string): boolean =>
  a.slice(0, BIND_HEAD_CHARS) === b.slice(0, BIND_HEAD_CHARS)
