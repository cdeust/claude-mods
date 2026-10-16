// Whether the owner's options reach this mod. The engine reads `pluginConfigs[<plugin id>].options` and
// the plugin id of an installed mod is `<name>@<marketplace>`; the bare `<name>` is read only for a mod
// loaded by directory (`<name>@inline`). A bare key beside a marketplace install binds to nothing: the
// mod runs on the manifest defaults and says nothing, so the options in effect are named here.

// source: Claude Code 2.1.300, the plugin option lookup (strings of the binary, read 2026-10-15): the
// ids tried for `x@inline` are `x` then `x@inline`, for any other id the id alone; and a live probe the
// same day, a directory-loaded mod reading a value from `pluginConfigs["name"]` and `["name@inline"]`.
export const SETTINGS_PATH = '~/.claude/settings.json'

export type Unbound = { key: string; ids: string[] }

type Installed = { plugins?: Record<string, { installPath?: string }[] | undefined> }

const trimmed = (path: string): string => path.replace(/\/+$/, '')

// The id this copy of the mod runs under: the installed id whose install folder is the folder the engine
// loaded it from (`$.plugin.root`), else the directory-loaded `<plugin>@inline`. Which copy is running
// matters: the engine reads one key for it, and a copy of the same mod beside it reads another.
export const runningId = (installed: Installed, plugin: string, root: string): string =>
  Object.entries(installed.plugins ?? {}).find(
    ([id, records]) => id.startsWith(`${plugin}@`) && (records ?? []).some((r) => r.installPath !== undefined && trimmed(r.installPath) === trimmed(root)),
  )?.[0] ?? `${plugin}@inline`

// The bare key of `plugin` in settings.json when no copy reads it: this copy is an installed one, its
// marketplace key is absent, and the bare key is there. A directory-loaded copy reads the bare key, and a
// marketplace key beside it wins, so neither is a false alarm.
export const unboundKeys = (settingsText: string, installedText: string | undefined, plugin: string, root: string): Unbound[] => {
  let settings: { pluginConfigs?: Record<string, unknown> }
  let installed: Installed
  try {
    settings = JSON.parse(settingsText) as typeof settings
    installed = installedText === undefined ? {} : (JSON.parse(installedText) as Installed)
  } catch (error) {
    throw new Error(`settings.json or installed_plugins.json is not valid JSON (${error instanceof Error ? error.message : String(error)})`.slice(0, 160))
  }
  const configs = settings.pluginConfigs ?? {}
  if (!(plugin in configs)) return []
  const id = runningId(installed, plugin, root)
  return id.endsWith('@inline') || id in configs ? [] : [{ key: plugin, ids: [id] }]
}

// The one line the toast and the POLICY panel carry.
export const unboundMessage = (u: Unbound, mode: string): string =>
  `settings.json pluginConfigs["${u.key}"] is not read by ${u.ids.join(', ')}: key it "${u.ids[0]}". Running on ${mode} from the manifest defaults`
