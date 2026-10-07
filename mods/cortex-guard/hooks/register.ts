import { atom, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Refusal } from '../types'
import { type CallInput, judgeCall, judgePath, worktreeAddPath } from './guard'

const REFUSALS_CAP = 200 // source: bounds $.state size; a viewer shows the last rows only

const refusals = atom({ plugin: 'cortex-guard', key: 'refusals' } as const, [] as Refusal[])

// Module state: where the repo is and which script registers a worktree. A hot reload runs
// session.start again, so both are set afresh.
let repo = ''
let hygieneScript = ''

// Where a path lands once links and `..` are resolved; the spelling when it does not exist yet.
async function realPathOf($: EngineInterface, path: string): Promise<string> {
  try {
    const stat = await $.fs.stat(path, { resolve: true })
    return (stat as { realPath?: string }).realPath ?? path
  } catch {
    return path
  }
}

// Pairs with the worktree rule: a worktree that exists is registered, as CLAUDE.md prescribes
// (the registered cleanup procedure, 2026-09-26).
async function registerWorktree($: EngineInterface, path: string): Promise<void> {
  if (hygieneScript === '') return
  const real = await realPathOf($, path)
  const ran = await $.process.run([
    'python3',
    hygieneScript,
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
      : `worktree NOT registered (${ran.stderr.slice(0, 80)})`,
  )
}

export const register: Register = (on, options) => {
  hygieneScript = String(options.hygiene_script ?? '')

  on('session.start', async ($, e, next) => {
    repo = (await $.session.repo())?.root ?? e.cwd

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
