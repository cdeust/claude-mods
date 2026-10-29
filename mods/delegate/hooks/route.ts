// Which model and effort a delegated task needs. Pure. Two instruments read the brief and name a class: the
// on-device model (fm.ts) first, the regex below when it cannot answer. One table turns a class into the pair, so a
// model and an effort never come from different sources.

export type Model = 'haiku' | 'sonnet' | 'opus'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh'
export type Class = 'read' | 'build' | 'judge' | 'critical'
export type Pair = { model: Model; effort: Effort }
export type Brief = { subagent_type?: string; description?: string; prompt?: string }

export const CLASSES: Record<Class, Pair> = {
  read: { model: 'haiku', effort: 'low' },
  build: { model: 'sonnet', effort: 'medium' },
  judge: { model: 'opus', effort: 'high' },
  critical: { model: 'opus', effort: 'xhigh' },
}

// Types the engine ships. A custom type (a plugin's agent) pins its own model in its definition: untouched.
const BUILT_IN = new Set(['general-purpose', 'Explore', 'Plan', 'claude-code-guide', 'statusline-setup'])

// A call the mod does not decide: a fork inherits its parent's model and effort, a custom type has its definition's.
export const pinned = (task: Brief): boolean =>
  task.subagent_type === 'fork' || (task.subagent_type !== undefined && !BUILT_IN.has(task.subagent_type))

// Words are matched at the start of a word, so `fix` also matches `fixes`; French stems are written without the
// accent, matched on the accent-stripped text.
const word = (stems: string): RegExp => new RegExp(`(^|[^a-z])(${stems})`)
const JUDGE = word('review|audit|secur|threat|architect|design|plan|critical|experiment|measur|benchmark|revue|conce|concev|menace|mesur')
const BUILD = word('implement|fix|refactor|write|edit|add|migrat|test|debug|build|creat|updat|rename|port|ecri|corrig|ajout|cree|modifi|construi')
const READ = word('search|find|locat|list|grep|explor|map|read|crawl|scrape|fetch|web|look up|lookup|survey|inventor|check|cherch|trouv|liste|lis |lire|recherch|inspect|summari|resum')

const plain = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export type Guess = { cls: Class; by: 'regex' | 'default'; rule: string }

// The regex instrument. It never answers `critical`: that class is for the model's reading of the whole brief.
export function guess(task: Brief): Guess {
  const type = task.subagent_type
  if (type === 'Explore') return { cls: 'read', by: 'regex', rule: 'Explore reads and locates' }
  if (type === 'claude-code-guide' || type === 'statusline-setup') {
    return { cls: 'read', by: 'regex', rule: `${type} looks up and edits one setting` }
  }
  if (type === 'Plan') return { cls: 'judge', by: 'regex', rule: 'Plan designs' }

  const said = plain(task.description ?? '') || plain((task.prompt ?? '').slice(0, 300))
  if (JUDGE.test(said)) return { cls: 'judge', by: 'regex', rule: 'review, design, measurement or security: judgment' }
  if (BUILD.test(said)) return { cls: 'build', by: 'regex', rule: 'implementation' }
  if (READ.test(said)) return { cls: 'read', by: 'regex', rule: 'search, web or read: no judgment needed' }
  return { cls: 'build', by: 'default', rule: 'default: unclassified task' }
}

export type Route = Pair & { rule: string }

// null: leave the call alone (pinned). Otherwise the regex's pair and the rule that gave it.
export function route(task: Brief): Route | null {
  if (pinned(task)) return null
  const g = guess(task)
  return { ...CLASSES[g.cls], rule: g.rule }
}
