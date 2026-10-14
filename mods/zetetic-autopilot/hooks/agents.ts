// Pure side of an agent type's definition: where its file is and which model and effort its
// frontmatter pins. `agent.spawn` carries the Agent call's `model` only, never the definition's
// (measured 2026-10-14: memory-writer, defined haiku, spawned with `model` undefined and resolved
// to claude-haiku-5-5 below the hook), so the router reads the file itself.

// source: ~/.claude/plugins/installed_plugins.json, the engine's record of installed plugins;
// `plugins["<name>@<marketplace>"][0].installPath` is the folder a session runs.
export const INSTALLED_PLUGINS_PATH = '~/.claude/plugins/installed_plugins.json'

// source: measured 2026-10-14 with a probe mod (agent.spawn result, turn.step): Explore, Plan and
// general-purpose spawned with no `model` from an opus parent resolved to the parent's model.
export const INHERITING_BUILT_INS: readonly string[] = ['Explore', 'Plan', 'general-purpose']

export type Definition = { model?: string; effort?: string }

// The folders from `dir` up to the filesystem root, nearest first; `/` and `\\` both separate.
export const ancestors = (dir: string): string[] => {
  const out: string[] = []
  let current = dir.length > 1 ? dir.replace(/[\\/]+$/, '') : dir
  for (;;) {
    out.push(current)
    const cut = Math.max(current.lastIndexOf('/'), current.lastIndexOf('\\'))
    if (cut < 0) return out
    if (cut === 0) return current === '/' ? out : [...out, '/']
    current = current.slice(0, cut)
  }
}

type Install = { scope?: unknown; projectPath?: unknown; installPath?: unknown }

// source: Claude Code's settings precedence (local over project over user), applied to the scopes
// `installed_plugins.json` records (`scope`: user, project, local; `projectPath` for the last two,
// measured 2026-10-14 on ~/.claude/plugins/installed_plugins.json). The engine's own choice among
// several entries is not documented in the mods reference: this order is the assumption (issue #11).
const USER = 2
const SCOPE_RANK: Record<string, number> = { local: 0, project: 1, user: USER }
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')

// The install path a session in `cwd` runs: among the entries whose scope covers the session (user
// entries always, project and local ones when their `projectPath` is `cwd` or a folder above it) the
// narrowest scope, then the first listed. An entry with no scope is the user's.
export const activeInstallPath = (installs: readonly Install[], cwd: string): string | undefined => {
  const here = new Set(ancestors(cwd).map(norm))
  const covering: { path: string; rank: number }[] = []
  for (const i of installs) {
    if (typeof i.installPath !== 'string' || i.installPath === '') continue
    const rank = typeof i.scope === 'string' ? (SCOPE_RANK[i.scope] ?? USER) : USER
    if (rank !== USER && !(typeof i.projectPath === 'string' && here.has(norm(i.projectPath)))) continue
    covering.push({ path: i.installPath, rank })
  }
  // Array.prototype.sort is stable: equal ranks keep their listed order.
  return covering.sort((x, y) => x.rank - y.rank)[0]?.path
}

// The files that may define a type, in the engine's precedence: a plugin's `agents/<name>.md`
// for `<plugin>:<name>` (`agents/<sub>/<name>.md` for `<plugin>:<sub>:<name>`) from the install
// that runs in `cwd`, else the project's `.claude/agents/` in each of `projectDirs` (the folders from
// the working directory up to the repository root, nearest first), then the user's (`claudeDir`, the
// engine's config directory: `~/.claude` or CLAUDE_CONFIG_DIR).
export const definitionPaths = (
  type: string,
  installedPluginsJson: string | undefined,
  claudeDir: string,
  cwd: string,
  projectDirs: readonly string[],
): string[] => {
  const colon = type.indexOf(':')
  if (colon < 0) return [...projectDirs.map((dir) => `${dir}/.claude/agents/${type}.md`), `${claudeDir}/agents/${type}.md`]
  const plugin = type.slice(0, colon)
  // `<plugin>:<sub>:<name>` is the plugin's agents/<sub>/<name>.md.
  const name = type.slice(colon + 1).split(':').join('/')
  if (installedPluginsJson === undefined) return []
  let parsed: { plugins?: Record<string, Install[]> }
  try {
    parsed = JSON.parse(installedPluginsJson) as typeof parsed
  } catch (error) {
    // A record that is not JSON is not "plugin not installed": the caller is told which it is.
    throw new Error(`installed_plugins.json is not valid JSON (${error instanceof Error ? error.message : String(error)})`.slice(0, 160))
  }
  return Object.entries(parsed.plugins ?? {})
    .filter(([key]) => key.startsWith(`${plugin}@`))
    .map(([, installs]) => activeInstallPath(installs, cwd))
    .filter((p): p is string => p !== undefined)
    .map((root) => `${root}/agents/${name}.md`)
}

// The `model:` and `effort:` lines of the leading `---` block; a file without one pins nothing.
export const parseDefinition = (md: string): Definition => {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (block === null) return {}
  const field = (name: string): string | undefined => {
    const m = new RegExp(`^${name}:[ \\t]*["']?([^"'\\s#]+)`, 'm').exec(block[1] ?? '')
    return m?.[1]
  }
  const model = field('model')
  const effort = field('effort')
  return { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) }
}

// The model a definition pins; `inherit` and an absent line both leave it to the parent.
export const pinnedModel = (d: Definition): string | undefined =>
  d.model === undefined || d.model === 'inherit' ? undefined : d.model
