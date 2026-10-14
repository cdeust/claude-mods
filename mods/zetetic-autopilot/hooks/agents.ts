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

// The files that may define a type, in the engine's precedence: a plugin's `agents/<name>.md`
// for `<plugin>:<name>`, else the project's `.claude/agents/`, then the user's (`claudeDir`, the
// engine's config directory: `~/.claude` or CLAUDE_CONFIG_DIR).
export const definitionPaths = (
  type: string,
  installedPluginsJson: string | undefined,
  claudeDir: string,
  cwd: string,
): string[] => {
  const colon = type.indexOf(':')
  if (colon < 0) return [`${cwd}/.claude/agents/${type}.md`, `${claudeDir}/agents/${type}.md`]
  const plugin = type.slice(0, colon)
  const name = type.slice(type.lastIndexOf(':') + 1)
  if (installedPluginsJson === undefined) return []
  let parsed: { plugins?: Record<string, { installPath?: unknown }[]> }
  try {
    parsed = JSON.parse(installedPluginsJson) as typeof parsed
  } catch (error) {
    // A record that is not JSON is not "plugin not installed": the caller is told which it is.
    throw new Error(`installed_plugins.json is not valid JSON (${error instanceof Error ? error.message : String(error)})`.slice(0, 160))
  }
  return Object.entries(parsed.plugins ?? {})
    .filter(([key]) => key.startsWith(`${plugin}@`))
    .map(([, installs]) => installs[0]?.installPath)
    .filter((p): p is string => typeof p === 'string' && p !== '')
    .map((root) => `${root}/agents/${name}.md`)
}

// The `model:` and `effort:` lines of the leading `---` block; a file without one pins nothing.
export const parseDefinition = (md: string): Definition => {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (block === null) return {}
  const field = (name: string): string | undefined => {
    const m = new RegExp(`^${name}:\\s*["']?([^"'\\s#]+)`, 'm').exec(block[1] ?? '')
    return m?.[1]
  }
  const model = field('model')
  const effort = field('effort')
  return { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) }
}

// The model a definition pins; `inherit` and an absent line both leave it to the parent.
export const pinnedModel = (d: Definition): string | undefined =>
  d.model === undefined || d.model === 'inherit' ? undefined : d.model
