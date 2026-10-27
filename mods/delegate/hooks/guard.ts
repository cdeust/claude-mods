// What the main loop may still do itself: orchestrate. Everything else is a task and goes to a subagent.

const ORCHESTRATION = [
  'Agent', 'SendMessage', 'AskUserQuestion', 'Skill', 'ToolSearch', 'TaskStop', 'TodoWrite', 'TaskCreate',
  'TaskUpdate', 'TaskList', 'TaskGet', 'EnterPlanMode', 'ExitPlanMode', 'ScheduleWakeup', 'ReadNotifications',
  'CronCreate', 'CronDelete', 'CronList', 'ListAgents', 'Workflow', 'EndConversation', 'SendFeedback',
  'PushNotification', 'SendUserFile', 'FetchInboxMessage',
]
// The memory servers are how the main loop recalls and remembers: a lookup, not a task.
const PREFIXES = ['mcp__plugin_hypermnesia-mcp_cortex__', 'mcp__plugin_zetetic-team-subagents_memory__']

export const parseAllow = (text: string): string[] =>
  text.split(',').map((s) => s.trim()).filter((s) => s !== '')

export function isOrchestration(tool: string, extra: readonly string[] = []): boolean {
  if (ORCHESTRATION.includes(tool) || PREFIXES.some((p) => tool.startsWith(p))) return true
  return extra.some((x) => (x.endsWith('*') ? tool.startsWith(x.slice(0, -1)) : x === tool))
}

// The two things the main loop keeps besides orchestration, for the Stop reflection hook and nothing else:
// reading a subagent's transcript, and lifting one reflection memory with the ledger script. Both are matched
// strictly, on the whole string; anything else stays a subagent's work.

// A subagent's transcript: <...>/.claude/projects/<...>/subagents/<...>.jsonl, absolute, no `..` segment.
export function isSubagentTranscript(path: unknown): boolean {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) return false
  if (path.split('/').includes('..')) return false
  const marker = '/.claude/projects/'
  const root = path.indexOf(marker)
  if (root < 0) return false
  return path.indexOf('/subagents/', root + marker.length - 1) >= 0 && path.endsWith('.jsonl')
}

// The script is the plugin cache's copy: an absolute path under a home directory, `/.claude/plugins/cache/`, then
// `/tools/reflection_ledger.py`; `--cwd` is an absolute path. Neither may hold a `..` segment (checked in isLiftCommand).
export const LIFT_COMMAND =
  /^python3 \/(?:Users|home)\/[^\s/]+\/\.claude\/plugins\/cache\/\S+\/tools\/reflection_ledger\.py --cwd \/\S* lift [a-f0-9]+ --memory-id [0-9]+$/
// The metacharacters the owner named (; & | ` $ ( ) < > newline), then the ones that still change what a word
// means to the shell (quotes, backslash, braces, globs, !, #, ~) or end a line (carriage return).
const SHELL_META = /[;&|`$()<>\r\n'"\\{}*?[\]!#~]/

export function isLiftCommand(command: unknown): boolean {
  return (
    typeof command === 'string' &&
    !SHELL_META.test(command) &&
    LIFT_COMMAND.test(command) &&
    !command.split(' ').some((word) => word.split('/').includes('..'))
  )
}

export function isReflectionCall(call: { tool: string; file_path?: unknown; command?: unknown }): boolean {
  if (call.tool === 'Read') return isSubagentTranscript(call.file_path)
  if (call.tool === 'Bash') return isLiftCommand(call.command)
  return false
}

export const refusal = (tool: string): string =>
  `delegate: the main loop only delegates, so ${tool} is a subagent's work. Call Agent with the model and effort the task needs.`
