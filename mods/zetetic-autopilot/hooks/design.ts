// The design gate: a delegation the model starts must open its prompt with the DESIGN block the
// dispatch-contract skill fixes (task, model, effort, genius shape). Pure; the register refuses the
// spawn under enforce and logs it under observe.
// source: zetetic-insights ledger, 2026-10-16 brief: 44 of 95 delegations undesigned; a replay of the
// last four days' transcripts found 22 Agent calls from main, none with a block
// (docs/verification/phase-attribution-2026-10-16.md).

// The block as zetetic-insights parses it (delegations.ts parseDesign): a line that is exactly
// `DESIGN`, the fields on the lines after it up to the first blank line. The same test, so a prompt
// this gate lets through is never counted undesigned there.
export const hasDesign = (prompt: unknown): boolean =>
  typeof prompt === 'string' && prompt.split(/\r?\n/).some((l) => l.trim() === 'DESIGN')

// Spawns the gate leaves alone: a fork inherits its parent's context and model, a workflow's agent
// can only be refused as a whole run, and a teammate is addressed, not designed per call.
export const isGated = (e: { fork: boolean; workflow?: unknown; isTeammate?: true }): boolean =>
  !e.fork && e.workflow === undefined && e.isTeammate !== true

// The block as the skill writes it. source: ~/.claude/skills/dispatch-contract/SKILL.md, the DESIGN
// template (2026-10-16).
export const DENY = [
  'Refused by zetetic-autopilot: this delegation has no DESIGN block.',
  'Load the dispatch-contract skill, open the prompt with its block, add its Contract verbatim:',
  '',
  'DESIGN',
  'task: <goal>; binds to <files/symbols>; non-goals <...>',
  'check: <command> → <expected result>',
  'model: <model> · effort: <level> · why: <one line from effort-calibration>',
  'genius shape: <shape> → <genius agent>: <key moves>',
  'surface: <api | agent-sdk | subagent> · why: <one line>',
  '',
  'then call Agent again with the same subagent_type.',
].join('\n')
