import { atom, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Refusal } from '../types'
import { type CallInput, judgeCall, judgePath, worktreeAddPath } from './guard'
import { placePath } from './paths'
import { PYTHON_CANDIDATES } from './rules'

const REFUSALS_CAP = 200 // source: bounds $.state size; a viewer shows the last rows only
const REASON_CAP = 80 // source: own choice, a toast shows a cause in a line

const refusals = atom({ plugin: 'cortex-guard', key: 'refusals' } as const, [] as Refusal[])

// Module state: where the repo is and which script registers a worktree. A hot reload runs
// session.start again, so all of it is set afresh. `script` is the option as configured (`~/` is
// the running user's home, computed per machine); `missingSaid` keeps the "not found" toast, and the
// "no python could run" toast, to one per session and stops further attempts after either. `python`
// is the first of PYTHON_CANDIDATES that starts, resolved once per session.
let repo = ''
let script = ''
let missingSaid = false
let python: { argv0: string } | { reason: string } | undefined

// Where a path lands once links and `..` are resolved; the spelling when it does not exist yet.
async function realPathOf($: EngineInterface, path: string): Promise<string> {
  try {
    const stat = await $.fs.stat(path, { resolve: true })
    return (stat as { realPath?: string }).realPath ?? path
  } catch {
    return path
  }
}

const why = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, REASON_CAP)

// The script's place on this machine, or the reason it has none: `~/` is the home of the user
// running the session (HOME, else USERPROFILE), read from the environment, never a path baked into
// the mod.
async function scriptPath($: EngineInterface): Promise<{ path: string } | { reason: string }> {
  if (!script.startsWith('~/')) return { path: script }
  try {
    return placePath(
      { home: await $.env.get('HOME'), userProfile: await $.env.get('USERPROFILE'), configDir: await $.env.get('CLAUDE_CONFIG_DIR') },
      script,
    )
  } catch (error) {
    return { reason: `the environment is unreadable: ${why(error)}` }
  }
}

// The first python that starts, `--version` exiting 0: a Store alias that exits non-zero, a name the
// machine does not have and a launch the sandbox refuses are all "not this one", and when none
// starts the answer is every reason, in order.
async function pythonOf($: EngineInterface): Promise<{ argv0: string } | { reason: string }> {
  if (python !== undefined) return python
  const tried: string[] = []
  for (const candidate of PYTHON_CANDIDATES) {
    try {
      const ran = await $.process.run([candidate, '--version'])
      if (ran.exitCode === 0) return (python = { argv0: candidate })
      tried.push(`${candidate}: exit ${ran.exitCode}`)
    } catch (error) {
      tried.push(`${candidate}: could not start (${why(error)})`)
    }
  }

  return (python = { reason: tried.join('; ') })
}

// Says once per session that the script is missing; later worktrees stay unregistered without a
// second toast (the first one named the path and the cause).
function sayMissing($: EngineInterface, where: string, reason: string): void {
  if (missingSaid) return
  missingSaid = true
  $.ui.toast(`hygiene script not found at ${where}; worktrees are not registered (${reason})`)
}

// Pairs with the worktree rule: a worktree that exists is registered, as CLAUDE.md prescribes
// (the registered cleanup procedure, 2026-09-26).
async function registerWorktree($: EngineInterface, path: string): Promise<void> {
  if (script === '' || missingSaid) return
  const placed = await scriptPath($)
  if ('reason' in placed) return sayMissing($, script, placed.reason)
  try {
    await $.fs.stat(placed.path)
  } catch (error) {
    return sayMissing($, placed.path, why(error))
  }
  const py = await pythonOf($)
  if ('reason' in py) {
    // No python will start for the next worktree either: say it once, with every reason, and stop
    // trying for the session (no retry, no fallback).
    missingSaid = true
    $.ui.toast(`worktree NOT registered (no python could run: ${py.reason}); no further worktree is registered this session`)
    return
  }
  const real = await realPathOf($, path)
  try {
    const ran = await $.process.run([
      py.argv0,
      placed.path,
      '--host',
      'claude',
      '--session',
      await $.session.id(),
      'register-worktree',
      '--repo',
      repo,
      '--path',
      real,
    ])
    $.ui.toast(
      ran.exitCode === 0
        ? `worktree registered: ${real}`
        : `worktree NOT registered (${ran.stderr.slice(0, REASON_CAP)})`,
    )
  } catch (error) {
    missingSaid = true
    $.ui.toast(`worktree NOT registered (${py.argv0} could not run the script: ${why(error)}); no further worktree is registered this session`)
  }
}

export const register: Register = (on, options) => {
  script = String(options.hygiene_script ?? '')

  on('session.start', async ($, e, next) => {
    repo = (await $.session.repo())?.root ?? e.cwd
    missingSaid = false
    python = undefined

    return next(e)
  })

  // Fail closed: a guard that throws refuses.
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit', 'Bash'] }, async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as CallInput
    let verdict = judgeCall(tool, input)
    if (verdict.allow && input.file_path !== undefined)
      verdict = judgePath(await realPathOf($, input.file_path))
    if (verdict.allow) {
      const ran = await next(e)
      const added = tool === 'Bash' && !ran.isError ? worktreeAddPath(input.command ?? '') : undefined
      if (added !== undefined) void registerWorktree($, added)
      return ran
    }
    const target = input.file_path ?? input.notebook_path ?? (input.command ?? '').slice(0, 60)
    const at = await $.clock.now()
    await update($, refusals, (list) =>
      [...list, { at, tool, rule: verdict.rule, target }].slice(-REFUSALS_CAP),
    )
    $.ui.toast(`refused ${tool}: ${verdict.rule}`)

    return { deny: `cortex-guard (${verdict.rule}): ${verdict.reason}` }
  }).catch(($, e, next) =>
    next.called
      ? next(e)
      : { deny: `cortex-guard: its guard failed on ${String(e.tool)}, so the call was refused.` },
  )
}
