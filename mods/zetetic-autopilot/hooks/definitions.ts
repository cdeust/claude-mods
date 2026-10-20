// Reading agent definitions off the machine: where a `~/` path lands, and the definition file a subagent type
// names (agents.ts holds the pure side). The engine's `$` is passed in; nothing here keeps state.

import type { EngineInterface } from 'claude-code'

import { type Definition, INHERITING_BUILT_INS, INSTALLED_PLUGINS_PATH, ancestors, definitionPaths, parseDefinition } from './agents'
import { placePath } from './paths'

export type Unread = { unread: string; absent: boolean }

// Where a `~/` path lands on this machine: HOME, else USERPROFILE, and CLAUDE_CONFIG_DIR for what lives
// in the engine's config directory (paths.ts). No home to place it is an error with that reason.
export async function expandHome($: EngineInterface, path: string): Promise<string> {
  if (!path.startsWith('~/')) return path
  const placed = placePath(
    { home: await $.env.get('HOME'), userProfile: await $.env.get('USERPROFILE'), configDir: await $.env.get('CLAUDE_CONFIG_DIR') },
    path,
  )
  if ('reason' in placed) throw new Error(placed.reason)

  return placed.path
}

// The folders whose `.claude/agents/` may hold a project agent: the working directory and each
// folder above it up to the repository root (the first with a `.git`), so a session started in a
// subdirectory finds the project's agents. No repository above: the working directory alone.
async function projectDirs($: EngineInterface, cwd: string): Promise<string[]> {
  const chain = ancestors(cwd)
  for (const [i, dir] of chain.entries()) if (await $.fs.exists(`${dir}/.git`)) return chain.slice(0, i + 1)
  return [cwd]
}

export async function readDefinition($: EngineInterface, type: string): Promise<Definition | Unread> {
  try {
    const claudeDir = (await expandHome($, '~/.claude')).replace(/\/$/, '')
    const installed = type.includes(':') ? await $.fs.read(await expandHome($, INSTALLED_PLUGINS_PATH)) : undefined
    const cwd = await $.session.cwd()
    const paths = definitionPaths(type, installed, claudeDir, cwd, type.includes(':') ? [] : await projectDirs($, cwd))
    for (const path of paths) {
      // A file that exists and cannot be read throws: it is not "no such file".
      if (await $.fs.exists(path)) return parseDefinition(String(await $.fs.read(path)))
    }
    return paths.length === 0
      ? { unread: 'no installed plugin provides it', absent: true }
      : { unread: `no file at ${paths.join(', ')}`, absent: true }
  } catch (error) {
    return { unread: String(error).slice(0, 120), absent: false }
  }
}

// Agent definitions: what the type's file pins, or why it could not be read. A definition found, and
// a file proven absent, or no installed plugin providing the type (`absent`: the records answered
// "no such file" / "no such plugin"), are remembered for
// the session; a read that failed, or a record that could not be read, is asked again at the next
// spawn, so a transient error does not stand until /clear (issue #11). The built-ins measured to
// inherit pin nothing and have no file.
const definitions = new Map<string, Definition | Unread>()

export async function definitionOf($: EngineInterface, type: string): Promise<Definition | Unread> {
  const known = definitions.get(type)
  if (known !== undefined) return known
  const found = INHERITING_BUILT_INS.includes(type) ? {} : await readDefinition($, type)
  if (!('unread' in found) || found.absent) definitions.set(type, found)
  return found
}

export const forgetDefinitions = (): void => definitions.clear()
