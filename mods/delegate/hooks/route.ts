// Which model and effort a delegated task needs. Pure: the hook in register.tsx applies it only to what the
// orchestrator left unnamed; a model or an effort the Agent call names is never touched.

export type Model = 'haiku' | 'sonnet' | 'opus'
export type Effort = 'low' | 'medium' | 'high'
export type Route = { model: Model; effort: Effort; rule: string }
export type Task = { subagent_type?: string; description?: string; prompt?: string }

// Types the engine ships. A custom type (a plugin's agent) pins its own model in its definition: untouched.
const BUILT_IN = new Set(['general-purpose', 'Explore', 'Plan', 'claude-code-guide', 'statusline-setup'])

// Words are matched at the start of a word, so `fix` also matches `fixes`; French stems are written without the
// accent, matched on the accent-stripped text.
const word = (stems: string): RegExp => new RegExp(`(^|[^a-z])(${stems})`)
const JUDGE = word('review|audit|secur|threat|architect|design|plan|critical|revue|conce|concev|menace')
const BUILD = word('implement|fix|refactor|write|edit|add|migrat|test|debug|build|creat|updat|rename|port|ecri|corrig|ajout|cree|modifi|construi')
const READ = word('search|find|locat|list|grep|explor|map|read|crawl|scrape|fetch|web|look up|lookup|survey|inventor|check|cherch|trouv|liste|lis |lire|recherch|inspect|summari|resum')

const plain = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

// null: leave the call alone (a fork inherits, a custom type has its definition's model).
export function route(task: Task): Route | null {
  const type = task.subagent_type
  if (type === 'fork') return null
  if (type !== undefined && !BUILT_IN.has(type)) return null

  if (type === 'Explore') {
    const deep = plain(task.prompt ?? '').includes('very thorough')
    return { model: 'haiku', effort: deep ? 'medium' : 'low', rule: 'Explore reads and locates' }
  }
  if (type === 'claude-code-guide' || type === 'statusline-setup') {
    return { model: 'haiku', effort: 'low', rule: `${type} looks up and edits one setting` }
  }
  if (type === 'Plan') return { model: 'opus', effort: 'high', rule: 'Plan designs' }

  const said = plain(task.description ?? '') || plain((task.prompt ?? '').slice(0, 300))
  if (JUDGE.test(said)) return { model: 'opus', effort: 'high', rule: 'review, design or security: judgment' }
  if (BUILD.test(said)) return { model: 'sonnet', effort: 'medium', rule: 'implementation' }
  if (READ.test(said)) return { model: 'haiku', effort: 'low', rule: 'search, web or read: no judgment needed' }
  return { model: 'sonnet', effort: 'medium', rule: 'default: unclassified task' }
}
