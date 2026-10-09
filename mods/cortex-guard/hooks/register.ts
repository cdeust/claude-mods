import { atom, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Refusal } from '../types'
import { type CallInput, judgeCall, judgePath, worktreeAddPath } from './guard'

const REFUSALS_CAP = 200 // source: bounds $.state size; a viewer shows the last rows only
const REASON_CAP = 80 // source: own choice, a toast shows a cause in a line

const refusals = atom({ plugin: 'cortex-guard', key: 'refusals' } as const, [] as Refusal[])

// Module state: where the repo is and which script registers a worktree. A hot reload runs
// session.start again, so all of it is set afresh. `script` is the option as configured (`~/` is
// the running user's home, computed per machine); `missingSaid` keeps the "not found" toast, and the
// "python3 could not run" toast, to one per session and stops further attempts after either.
let repo = ''
let script = ''
let missingSaid = false

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
// running the session, read from the environment, never a path baked into the mod.
async function scriptPath($: EngineInterface): Promise<{ path: string } | { reason: string }> {
  if (!script.startsWith('~/')) return { path: script }
  try {
    const home = await $.env.get('HOME')
    if (home === undefined || home === '') return { reason: `HOME is not set, so ${script} has no place` }

    return { path: `${home}/${script.slice(2)}` }
  } catch (error) {
    return { reason: `HOME is unreadable: ${why(error)}` }
  }
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
  const real = await realPathOf($, path)
  try {
    const ran = await $.process.run([
      'python3',
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
    // A python3 that cannot start will not start for the next worktree either: say it once, with
    // the cause, and stop trying for the session (no retry, no fallback).
    missingSaid = true
    $.ui.toast(`worktree NOT registered (python3 could not run: ${why(error)}); no further worktree is registered this session`)
  }
}

export const register: Register = (on, options) => {
  script = String(options.hygiene_script ?? '')

  on('session.start', async ($, e, next) => {
    repo = (await $.session.repo())?.root ?? e.cwd
    missingSaid = false

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
