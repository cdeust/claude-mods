// Which model and effort a delegated task needs. Pure, and no text analysis: two models read the brief and name a
// class (fm.ts, jev.ts, decide.ts); one table turns the class into the pair, so a model and an effort never come
// from different sources. Only what the engine itself knows, the agent type, bounds the answer.

export type Model = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Class = 'read' | 'build' | 'judge' | 'critical'
export type Pair = { model: Model; effort: Effort }
export type Brief = { subagent_type?: string; description?: string; prompt?: string }

export const MODELS: readonly Model[] = ['haiku', 'sonnet', 'opus', 'fable']
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const CLASSES: Record<Class, Pair> = {
  read: { model: 'haiku', effort: 'low' },
  build: { model: 'sonnet', effort: 'medium' },
  judge: { model: 'opus', effort: 'high' },
  critical: { model: 'opus', effort: 'xhigh' },
}

// What each class means: the instructions of both models are built from these lines.
export const DEFINITIONS: Record<Class, string> = {
  read: 'mechanical lookup, listing or search whose result the caller can check.',
  build: 'implement, fix, refactor, write tests or run a build against a design that is already known.',
  judge: 'review, audit, security, design, experiment, measurement, or any answer the caller cannot check.',
  critical: 'irreversible or security-critical decisions, multi-system architecture.',
}

// Types the engine ships. A custom type (a plugin's agent) pins its own model in its definition: untouched.
const BUILT_IN = new Set(['general-purpose', 'Explore', 'Plan', 'claude-code-guide', 'statusline-setup'])

// A call the mod does not decide: a fork inherits its parent's model and effort, a custom type has its definition's.
export const pinned = (task: Brief): boolean =>
  task.subagent_type === 'fork' || (task.subagent_type !== undefined && !BUILT_IN.has(task.subagent_type))

const RANK: readonly Class[] = ['read', 'build', 'judge', 'critical']
export const rank = (c: Class): number => RANK.indexOf(c)
export const higher = (a: Class, b: Class): Class => (rank(a) >= rank(b) ? a : b)

// The agent type bounds the answer, whatever the brief says: Explore is a read-only search agent (ceiling build),
// Plan designs (floor judge). `note` says a bound changed the answer, so the disagreement stays measurable.
export function bound(cls: Class, task: Brief): { cls: Class; note?: 'capped' | 'floored' } {
  if (task.subagent_type === 'Explore' && rank(cls) > rank('build')) return { cls: 'build', note: 'capped' }
  if (task.subagent_type === 'Plan' && rank(cls) < rank('judge')) return { cls: 'judge', note: 'floored' }
  return { cls }
}
