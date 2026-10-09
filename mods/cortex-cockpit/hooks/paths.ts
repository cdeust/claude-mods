// Where `~/` lands on the machine a mod runs on. Pure: the engine follows `$` only inside the module
// that spells it, so each mod's register file reads the three variables and hands their values here.
//
// This file exists once per mod that expands `~/` (a mod cannot import a file from another mod: the
// engine refuses it, "outside the plugin's folder"), and every copy is byte-identical;
// scripts/check-shared.sh fails when one differs.

export type PathVars = { home: string | undefined; userProfile: string | undefined; configDir: string | undefined }
export type Placed = { path: string } | { reason: string }

const isSet = (value: string | undefined): value is string => value !== undefined && value !== ''
const trimmed = (dir: string): string => dir.replace(/[\\/]+$/, '')

// source: HOME is the home on macOS and Linux, USERPROFILE on Windows (cmd and PowerShell set it,
// not HOME); Node's os.homedir() reads them in that order on each platform. Unset in a sandbox: no
// place, said as such, never `/`.
export const homeOf = (vars: PathVars): Placed =>
  isSet(vars.home) ? { path: trimmed(vars.home) } : isSet(vars.userProfile) ? { path: trimmed(vars.userProfile) } : { reason: 'neither HOME nor USERPROFILE is set' }

// source: CLAUDE_CONFIG_DIR relocates the engine's `~/.claude` (plugins/, reference/, settings.json);
// without it the config directory is `<home>/.claude`.
export const configDirOf = (vars: PathVars): Placed => {
  if (isSet(vars.configDir)) return { path: trimmed(vars.configDir) }
  const home = homeOf(vars)

  return 'path' in home ? { path: `${home.path}/.claude` } : home
}

const CONFIG_PREFIX = '~/.claude'

// A path as the mods spell it: `~/.claude/...` is under the config directory, any other `~/...` under
// the home, anything else is already a place.
export const placePath = (vars: PathVars, path: string): Placed => {
  if (!path.startsWith('~/')) return { path }
  const isConfig = path === CONFIG_PREFIX || path.startsWith(`${CONFIG_PREFIX}/`)
  const base = isConfig ? configDirOf(vars) : homeOf(vars)
  if ('reason' in base) return { reason: `${path} has no place: ${base.reason}` }

  return { path: `${base.path}/${path.slice(isConfig ? CONFIG_PREFIX.length + 1 : 2)}` }
}
