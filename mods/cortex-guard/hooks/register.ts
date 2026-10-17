import { atom, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { Refusal } from '../types'
import { type AddPlace, type Adds, type CallInput, judgeCall, judgePath, placeWorktreeAdds, worktreeAdds } from './guard'
import { placePath } from './paths'
import { PYTHON_CANDIDATES } from './rules'

const REFUSALS_CAP = 200 // source: bounds $.state size; a viewer shows the last rows only
const REASON_CAP = 80 // source: own choice, a toast shows a cause in a line
// `git worktree add` waits for both runs below (the result carries the news to Claude), so a hung child
// delays it by its whole timeout; the engine default is 30 s each (`ProcessRunInit.timeoutMs`). A rejection on
// timeout takes the same catch path as a child that cannot start: reported, never blocking the add.
const PROBE_TIMEOUT_MS = 5_000 // source: own choice, `python --version` prints and exits at once; 5 s is generous
const REGISTER_TIMEOUT_MS = 10_000 // source: own choice, the script writes one registry entry; 10 s covers a cold disk

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
      const ran = await $.process.run([candidate, '--version'], { timeoutMs: PROBE_TIMEOUT_MS })
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
// (the registered cleanup procedure, 2026-09-26). Two readers, two channels: a failure is toasted to the user
// (who reads the toast alone) and returned as its reason, which the tool call carries to Claude in its
// result's `context` (what the model reads and the user never sees). Undefined: registered, or not asked for
// (the option is empty, no cleanup was promised).
async function registerWorktree($: EngineInterface, path: string): Promise<string | undefined> {
  if (script === '') return undefined
  if (missingSaid) return 'an earlier registration failed this session and none is tried again'
  const placed = await scriptPath($)
  if ('reason' in placed) {
    sayMissing($, script, placed.reason)
    return `the hygiene script has no place: ${placed.reason}`
  }
  try {
    await $.fs.stat(placed.path)
  } catch (error) {
    sayMissing($, placed.path, why(error))
    return `the hygiene script was not found at ${placed.path}: ${why(error)}`
  }
  const py = await pythonOf($)
  if ('reason' in py) {
    // No python will start for the next worktree either: say it once, with every reason, and stop
    // trying for the session (no retry, no fallback).
    missingSaid = true
    $.ui.toast(`worktree NOT registered (no python could run: ${py.reason}); no further worktree is registered this session`)
    return `no python could run: ${py.reason}`
  }
  const real = await realPathOf($, path)
  try {
    const ran = await $.process.run(
      [py.argv0, placed.path, '--host', 'claude', '--session', await $.session.id(), 'register-worktree', '--repo', repo, '--path', real],
      { timeoutMs: REGISTER_TIMEOUT_MS },
    )
    if (ran.exitCode === 0) {
      $.ui.toast(`worktree registered: ${real}`)
      return undefined
    }
    const stderr = ran.stderr.slice(0, REASON_CAP)
    $.ui.toast(`worktree NOT registered (${stderr})`)
    return stderr === '' ? `the script exited ${ran.exitCode}` : stderr
  } catch (error) {
    missingSaid = true
    $.ui.toast(`worktree NOT registered (${py.argv0} could not run the script: ${why(error)}); no further worktree is registered this session`)
    return `${py.argv0} could not run the script: ${why(error)}`
  }
}

// source: git-worktree(1) DETAILS: a linked worktree's `.git` is a file whose `gitdir:` names
// `<repo>/.git/worktrees/<id>` (a submodule's names `.git/modules/`, a main checkout's `.git` is a directory).
const WORKTREE_GITDIR = /^gitdir: .*[\\/]worktrees[\\/][^\\/]+\s*$/

// Whether `dir` is a linked worktree on disk now: the state a registration is decided on, not the call's outcome.
async function isWorktree($: EngineInterface, dir: string): Promise<boolean> {
  try {
    return WORKTREE_GITDIR.test(await $.fs.read(`${dir}/.git`))
  } catch {
    return false
  }
}

// Where each add's worktree lands, or why that is not known, one per add the refusal judged (the same reading of the
// command), a place named twice counted once. Never throws: it runs before the call, where a throw would refuse it.
async function placesOf($: EngineInterface, adds: Adds, agentId: string | undefined): Promise<{ place: AddPlace; named: string }[]> {
  const cwd = await $.session.cwd().catch(() => undefined)
  const places = placeWorktreeAdds(adds, cwd, agentId).map((place, k) => ({ place, named: 'path' in place ? place.path : (adds.adds[k]?.path ?? '') }))
  return places.filter(({ place }, k) => !('path' in place) || places.findIndex((other) => 'path' in other.place && other.place.path === place.path) === k)
}

// A command sent to the background (run_in_background, or a timeout that backgrounded it) has not finished
// when the call returns (the Bash result's `backgroundTaskId`).
const isBackgrounded = (ran: ToolCallResult): boolean => {
  const result: unknown = ran.result
  return typeof result === 'object' && result !== null && (result as { backgroundTaskId?: unknown }).backgroundTaskId !== undefined
}

// After the call: a worktree that is on disk now and was not before is this call's, and it is registered,
// whatever the call's outcome (a later `&&` step can fail; another plugin can deny a call that ran). Undefined:
// registered, or nothing to register; else the reason it was not, already toasted to the user. A call that
// reported no error, was not denied and was not sent to the background, yet left nothing at the place computed,
// is reported too: the place may be wrong (the shell was not where the text says), and a worktree that is
// elsewhere is not registered. The cost is a report for an add whose failure the command masked (`|| true`).
async function settleAdd($: EngineInterface, place: AddPlace, existed: boolean, ran: ToolCallResult): Promise<string | undefined> {
  if ('reason' in place) {
    $.ui.toast(`worktree NOT registered (${place.reason})`)
    return place.reason
  }
  if (existed) return undefined
  if (await isWorktree($, place.path)) return registerWorktree($, place.path)
  const backgrounded = isBackgrounded(ran)
  if (!backgrounded && (ran.isError === true || ran.deny !== undefined)) return undefined
  const reason = backgrounded
    ? `the command runs in the background, so whether ${place.path} exists was not checked`
    : `no worktree was found at ${place.path} after the call, which reported no error, so the worktree may be elsewhere`
  $.ui.toast(`worktree NOT registered (${reason})`)
  return reason
}

// What Claude reads on the result of the `git worktree add` it ran, when the worktree was not registered: the
// user was toasted (a toast is the user's alone), and Claude, which made the worktree, is the one who can
// register it by hand. Cleanup of an unregistered worktree is not done by the hooks.
const unregistered = (path: string, reason: string): string =>
  `cortex-guard: the worktree ${path} was NOT registered with the hygiene script (${reason}), so its cleanup is not covered. ` +
  'Register it by hand with disk_hygiene.py register-worktree, or tell the owner it is unregistered.'

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
      // The adds the refusal just judged: judgeCall read the command with worktreeAdds too, and found no doubt.
      const adds = tool === 'Bash' && script !== '' ? worktreeAdds(input.command ?? '') : undefined
      if (adds === undefined || adds.adds.length === 0) return next(e)
      // Looked at before the call: a worktree already there is not this call's to register.
      const places = await placesOf($, adds, e.agentId)
      const existed: boolean[] = []
      for (const { place } of places) existed.push('path' in place && (await isWorktree($, place.path)))
      const ran = await next(e)
      // Awaited: the result of this call is where Claude can be told a worktree is not covered.
      // A registration that throws must not turn a call that ran into a refusal: it is a reason, like any other.
      const told: string[] = []
      for (const [k, { place, named }] of places.entries()) {
        const reason = await settleAdd($, place, existed[k] === true, ran).catch((error: unknown) => `registration failed: ${why(error)}`)
        if (reason !== undefined) told.push(unregistered(named, reason))
      }
      // A deny carries no `context` (the engine's ToolCallResult): the user's toast is the only channel then.
      if (told.length === 0 || ran.deny !== undefined) return ran
      return { ...ran, context: [...(ran.context ?? []), ...told] }
    }
    const target = input.file_path ?? input.notebook_path ?? (input.command ?? '').slice(0, 60)
    const at = await $.clock.now()
    await update($, refusals, (list) =>
      [...list, { at, tool, rule: verdict.rule, target }].slice(-REFUSALS_CAP),
    )
    $.ui.toast(`refused ${tool}: ${verdict.rule}`)

    return { deny: `cortex-guard (${verdict.rule}): ${verdict.reason}` }
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    // Two readers: Claude reads the deny as the tool's error; the user reads a toast, or learns nothing of a
    // guard that stopped working.
    try {
      $.ui.toast(`cortex-guard failed on ${String(e.tool)}: the call was refused`)
    } catch {
      // The deny below is the answer whether or not the user could be told.
    }
    return { deny: `cortex-guard: its guard failed on ${String(e.tool)}, so the call was refused.` }
  })
}
