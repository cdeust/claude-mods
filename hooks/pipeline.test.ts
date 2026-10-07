import { expect, test } from 'claude-code/testing'

import { bump, emptyStages, shortName, stageOf } from './pipeline'

test('tools map to their pipeline stage', () => {
  expect(stageOf('mcp__plugin_hypermnesia-mcp_cortex__recall')).toBe('recall')
  expect(stageOf('mcp__plugin_ai-architect-mcp-spec_prd-gen__start_pipeline')).toBe('spec')
  expect(stageOf('mcp__plugin_ai-architect-mcp-spec_prd-gen__conclude_verification')).toBe(
    'spec-verify',
  )
  expect(stageOf('mcp__plugin_ai-architect-mcp-codebase_ai-architect__search_codebase')).toBe(
    'code-intel',
  )
  expect(stageOf('mcp__plugin_ai-architect-mcp-codebase_ai-architect__check_security_gates')).toBe(
    'gates',
  )
  expect(stageOf('mcp__plugin_hypermnesia-mcp_cortex__wiki_write')).toBe('wiki')
  expect(stageOf('Agent')).toBe('subagents')
  expect(stageOf('Bash', { command: 'git commit -m x' })).toBe('git')
  expect(stageOf('Bash', { command: 'git status' })).toBe(undefined)
  expect(stageOf('Read')).toBe(undefined)
})

test('bump counts calls and blocks per stage', () => {
  let s = emptyStages()
  s = bump(s, 'recall', 'mcp__plugin_hypermnesia-mcp_cortex__recall', 10, false)
  s = bump(s, 'recall', 'mcp__plugin_hypermnesia-mcp_cortex__recall', 20, true)
  expect(s.recall).toEqual({
    calls: 2,
    blocked: 1,
    lastAt: 20,
    lastTool: 'mcp__plugin_hypermnesia-mcp_cortex__recall',
  })
  expect(s.spec?.calls).toBe(0)
})

test('short names drop the MCP prefix', () => {
  expect(shortName('mcp__plugin_hypermnesia-mcp_cortex__recall')).toBe('recall')
  expect(shortName('mcp__plugin_ai-architect-mcp-spec_prd-gen__start_pipeline')).toBe(
    'start_pipeline',
  )
  expect(shortName('Bash')).toBe('Bash')
})
