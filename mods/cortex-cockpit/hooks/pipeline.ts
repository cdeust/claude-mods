import type { StageTally } from '../types'

// The spec-to-code pipeline as the harness runs it, read off the tools the model calls.
// Stage order and membership are the servers' own published orderings:
// source: prd-gen server instructions (coordinate_context_budget → start_pipeline →
//   get_pipeline_state → submit_action_result; plan_* → submit_action_result →
//   conclude_verification; validate_prd_*).
// source: ai-architect server instructions (stages 1 findings, 2 verification, 3 code
//   intelligence, 4/6 PRD grounding, 8/9 gates).
// source: Cortex server instructions (recall/remember, wiki_*).

export const STAGES = [
  'recall',
  'spec',
  'spec-verify',
  'code-intel',
  'grounding',
  'gates',
  'subagents',
  'remember',
  'wiki',
  'git',
] as const

export type Stage = (typeof STAGES)[number]

const PRD = 'mcp__plugin_ai-architect-mcp-spec_prd-gen__'
const ARCH = 'mcp__plugin_ai-architect-mcp-codebase_ai-architect__'
const CORTEX = 'mcp__plugin_hypermnesia-mcp_cortex__'

const BY_TOOL: Record<string, Stage> = {
  [`${CORTEX}recall`]: 'recall',
  [`${CORTEX}recall_hierarchical`]: 'recall',
  [`${CORTEX}unified_search`]: 'recall',
  [`${CORTEX}recall_skills`]: 'recall',
  [`${CORTEX}remember`]: 'remember',
  [`${CORTEX}checkpoint`]: 'remember',
  [`${PRD}coordinate_context_budget`]: 'spec',
  [`${PRD}start_pipeline`]: 'spec',
  [`${PRD}get_pipeline_state`]: 'spec',
  [`${PRD}submit_action_result`]: 'spec',
  [`${PRD}validate_prd_section`]: 'spec-verify',
  [`${PRD}validate_prd_document`]: 'spec-verify',
  [`${PRD}plan_section_verification`]: 'spec-verify',
  [`${PRD}plan_document_verification`]: 'spec-verify',
  [`${PRD}conclude_verification`]: 'spec-verify',
  [`${ARCH}prepare_prd_input`]: 'grounding',
  [`${ARCH}validate_prd_against_graph`]: 'grounding',
  [`${ARCH}check_doc_claims`]: 'grounding',
  [`${ARCH}check_security_gates`]: 'gates',
  [`${ARCH}verify_semantic_diff`]: 'gates',
  [`${ARCH}start_verification`]: 'gates',
  [`${ARCH}finalize_verification`]: 'gates',
}

const GIT_WRITE = /(^|[\s;&|])git\s+(commit|push|merge|rebase|worktree\s+add|tag)\b/

export const stageOf = (tool: string, input?: { command?: string }): Stage | undefined => {
  const direct = BY_TOOL[tool]
  if (direct !== undefined) return direct
  if (tool.startsWith(ARCH)) return 'code-intel'
  if (tool.startsWith(`${CORTEX}wiki_`)) return 'wiki'
  if (tool === 'Agent') return 'subagents'
  if (tool === 'Bash' && input?.command !== undefined && GIT_WRITE.test(input.command))
    return 'git'
  return undefined
}

export const emptyStages = (): Record<string, StageTally> =>
  Object.fromEntries(
    STAGES.map((s) => [s, { calls: 0, blocked: 0, lastAt: null, lastTool: null }]),
  )

export const bump = (
  stages: Record<string, StageTally>,
  stage: Stage,
  tool: string,
  now: number,
  isBlocked: boolean,
): Record<string, StageTally> => {
  const s = stages[stage] ?? { calls: 0, blocked: 0, lastAt: null, lastTool: null }
  return {
    ...stages,
    [stage]: {
      calls: s.calls + 1,
      blocked: s.blocked + (isBlocked ? 1 : 0),
      lastAt: now,
      lastTool: tool,
    },
  }
}

export const shortName = (tool: string): string => tool.replace(/^mcp__[^_]+(_[^_]+)*__/, '')
