// The offload as the engine sees it: the blocks of one stored tool-result row, the files written for
// the long ones, the blocks the model will read. The plan itself is offload.ts (pure); this is the
// part that writes and reports, with the policy state and the cockpit rows behind a `Sink`.
import type { EngineInterface } from 'claude-code'

import { type OffloadOptions, type OffloadPlan, planOffload, toolResultsDir } from './offload'
import { resultText } from './policy'

export type Block = { type: string; tool_use_id?: unknown; content?: unknown }

// What the offload tells the rest of the mod: a result that stays whole and why, and one offloaded.
export type Sink = {
  note: (subject: string, reason: string) => Promise<void>
  offloaded: (plan: OffloadPlan, applied: boolean) => Promise<void>
}

export type Context = { options: OffloadOptions; enforce: boolean; transcriptPath: string | undefined; sink: Sink }

// Writes each file whole; the reason of the first failure (4 MiB cap, a refusal, a full disk), else undefined.
async function writeAll($: EngineInterface, plan: OffloadPlan): Promise<string | undefined> {
  try {
    for (const f of plan.files) await $.fs.write(f.path, f.text)
  } catch (error) {
    return String(error).slice(0, 160)
  }
  return undefined
}

// The block the model will read in place of `block`: the pointer, as the string or the text block
// the result came as.
const pointer = <B extends Block>(block: B, message: string): B =>
  typeof block.content === 'string' ? { ...block, content: message } : { ...block, content: [{ type: 'text', text: message }] }

// pre:  `block` is a tool_result whose text is past the threshold (planOffload decides about the
//       engine's own pointers); `dir` is the session's tool-results directory or undefined.
// post: the block unchanged (and a note saying why) when the directory is unknown or the write was
//       refused; under observe the block unchanged and nothing written; else the file(s) hold the
//       text whole and the returned block is the pointer. Nothing is ever dropped.
async function offloadOne<B extends Block>(
  $: EngineInterface,
  tool: string,
  block: B,
  text: string,
  dir: string | undefined,
  ctx: Context,
  fallbackId: string,
): Promise<B> {
  const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : fallbackId
  const joined = Array.isArray(block.content) && block.content.length > 1
  const plan = planOffload(text, id, dir ?? '', ctx.options, joined)
  if (plan === undefined) return block
  if (dir === undefined) {
    await ctx.sink.note('tool-results directory', 'the session directory is not known; the result stays whole')
    return block
  }
  if (ctx.enforce) {
    const failure = await writeAll($, plan)
    if (failure !== undefined) {
      await ctx.sink.note(`${tool} result`, `not written, stays whole: ${failure}`)
      return block
    }
  }
  await ctx.sink.offloaded(plan, ctx.enforce)

  return ctx.enforce ? pointer(block, plan.message) : block
}

// The row's blocks with the long results offloaded; undefined when none changed.
export async function offloadBlocks<B extends Block>(
  $: EngineInterface,
  rowId: string,
  tool: string,
  blocks: readonly B[],
  ctx: Context,
): Promise<B[] | undefined> {
  let dir: string | undefined
  let known = false
  let changed = false
  const out: B[] = []
  for (const block of blocks) {
    const text = block.type === 'tool_result' ? resultText(block.content) : undefined
    if (text === undefined || text.length <= ctx.options.thresholdChars) {
      out.push(block)
      continue
    }
    // Asked once, and only when a result is past the threshold: most results never need the directory.
    if (!known) {
      dir = toolResultsDir(ctx.transcriptPath, await $.session.id())
      known = true
    }
    const next = await offloadOne($, tool, block, text, dir, ctx, rowId)
    changed = changed || next !== block
    out.push(next)
  }

  return changed ? out : undefined
}
