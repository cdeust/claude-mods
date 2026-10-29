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

// What the main loop keeps besides orchestration, for the Stop reflection hook and nothing else: four call shapes,
// each matched on the whole input. A ledger lift or list (Bash), and a Read or one read-only grep (Bash) of
// subagent transcripts. The shapes are here and pure; for a transcript, register.tsx then checks the disk
// (isTranscriptOnDisk). Anything else stays a subagent's work.

export type Call = { tool: string; file_path?: unknown; command?: unknown }

// A subagent's transcript is exactly <HOME>/.claude/projects/<project>/<session>/subagents/<name>.jsonl, the
// layout of every transcript the engine writes (all 219 on the author's disk). A segment is a name that does not
// start with a dot, so a dot segment, a dot-dot segment, an empty segment (a double slash) and any space or shell
// character never match.
const SEGMENT = '[A-Za-z0-9_-][A-Za-z0-9._-]*'
const TAIL = new RegExp(`^${SEGMENT}/${SEGMENT}/subagents/${SEGMENT}\\.jsonl$`)
// HOME, as the engine's environment has it: absolute, no empty, dot or dot-dot segment, no trailing slash.
const HOME = new RegExp(String.raw`^(?:\/(?!\.\.?(?:\/|$))[^\/\0]+)+$`)

export function projectsDir(home: string): string {
  return `${home}/.claude/projects`
}

// The part of the path under <HOME>/.claude/projects/, when the path is a subagent transcript of this HOME.
export function transcriptTail(path: unknown, home: unknown): string | undefined {
  if (typeof path !== 'string' || typeof home !== 'string' || !HOME.test(home)) return undefined
  const root = `${projectsDir(home)}/`
  if (!path.startsWith(root)) return undefined
  const tail = path.slice(root.length)
  return TAIL.test(tail) ? tail : undefined
}

export function isSubagentTranscript(path: unknown, home: unknown): boolean {
  return transcriptTail(path, home) !== undefined
}

// What the engine's fs.stat answers with { resolve: true } (its FsStat): what the path leads to, whether the path
// itself is a symbolic link, and where it lands.
export type Stat = { kind: string; isLink: boolean; realPath?: string }

// The disk half, for a path whose shape passed: the path itself is a regular file (not a link, not a directory) and
// it lands at the same place under the real <HOME>/.claude/projects, so no segment below that folder is a link
// either. The projects argument is the stat of projectsDir(home); a link at or above it is the owner's and is followed.
export function isTranscriptOnDisk(file: Stat, projects: Stat, path: string, home: string): boolean {
  const tail = transcriptTail(path, home)
  return (
    tail !== undefined && projects.kind === 'dir' && projects.realPath !== undefined &&
    file.kind === 'file' && !file.isLink && file.realPath === `${projects.realPath}/${tail}`
  )
}

// A shell command is accepted only in this form: words of printable ASCII (0x21 to 0x7e) separated by one space,
// with no leading or trailing space. zsh and bash split words on space, tab and newline, and on no other character
// from 0x01 to 0x7f nor any Unicode space (checked one by one, with the Claude Code shell snapshot sourced). So on
// every accepted command the shell's words are exactly command.split(' '): the guard checks the argv the shell builds.
const WORDS = new RegExp(String.raw`^[!-~]+(?: [!-~]+)*$`)
// Inside that alphabet, the characters that still change what a word means to the shell: the metacharacters
// (semicolon, ampersand, pipe, angle brackets, parentheses), quotes, backslash and backquote, expansions (dollar,
// braces, tilde), globs (star, question mark, square brackets), history (bang), comments (hash), and zsh's
// EXTENDED_GLOB operators (caret, tilde, hash), which a user's zsh options may turn on (a word ^x then lists the
// working folder).
const SHELL_META = new RegExp(String.raw`[;&|${'`'}$()<>'"\\{}*?[\]!#~^]`)

// The argv the shell builds from the command, when the command is in the form above and holds no character the
// shell would read as more than itself; undefined otherwise. Every Bash shape below is checked on these words.
export function shellWords(command: unknown): string[] | undefined {
  if (typeof command !== 'string' || !WORDS.test(command) || SHELL_META.test(command)) return undefined
  return command.split(' ')
}

function plainCommand(command: unknown): command is string {
  return shellWords(command) !== undefined
}

function hasDotDot(path: string): boolean {
  return path.split('/').includes('..')
}

// The script is the plugin cache's copy: an absolute path under a home directory, /.claude/plugins/cache/, then
// /tools/reflection_ledger.py; --cwd is an absolute path. Neither path may hold a dot-dot segment (isLedgerCommand).
const LEDGER = String.raw`python3 (\/(?:Users|home)\/[^\s/]+\/\.claude\/plugins\/cache\/\S+\/tools\/reflection_ledger\.py) --cwd (\/\S*)`
// source: zetetic-team-subagents hooks/stop-reflection-gate.py, _entry_text and block_reason (the lift and list lines).
export const LIFT_COMMAND = new RegExp(`^${LEDGER} lift [a-f0-9]+ --memory-id [0-9]+$`)
// list only prints the pending reflections (reflection_ledger.py: list calls pending() and print(); no write).
export const LIST_COMMAND = new RegExp(`^${LEDGER} list$`)

function isLedgerCommand(command: unknown, shape: RegExp): boolean {
  if (!plainCommand(command)) return false
  const m = shape.exec(command)
  return m !== null && !hasDotDot(m[1] ?? '..') && !hasDotDot(m[2] ?? '..')
}

export function isLiftCommand(command: unknown): boolean {
  return isLedgerCommand(command, LIFT_COMMAND)
}

export function isListCommand(command: unknown): boolean {
  return isLedgerCommand(command, LIST_COMMAND)
}

export function isLedgerCall(call: Call): boolean {
  return call.tool === 'Bash' && (isLiftCommand(call.command) || isListCommand(call.command))
}

// One read-only grep over subagent transcripts: grep [flags] [-e PATTERN | PATTERN] FILE..., options first.
// Flags: clusters of c o E F i n h H, and -m|-A|-B|-C <digits>. A pattern is a plain word (no quotes, so no
// spaces, and no shell metacharacter, so no pipe or dollar) that starts with neither a dash nor an equals sign (zsh
// replaces a word starting with one by a command's path). No -r, no -f, no other option.
const GREP_CLUSTER = /^-[coEFinhH]+$/
const GREP_COUNTED = /^-[mABC]$/
// source: PR 50's pattern alphabet, less the caret and a leading equals sign (README, "What the main loop keeps": zsh EXTENDED_GLOB and EQUALS).
const GREP_PATTERN = new RegExp(String.raw`^[A-Za-z0-9_.:,@%+\/][A-Za-z0-9_.:=,@%+\/-]*$`)
// The output bound. A transcript line is one whole message: 4.6 KB on average and up to 719 KB on the author's disk,
// so a number of lines never bounds bytes. What is bounded is how many lines and files: a grep that prints lines
// carries -m (1 to 10 matching lines a file), context is 0 to 2 lines, and at most 5 files (the Stop reflection
// hook lists at most 5 pending reflections, stop-reflection-gate.py MAX_LISTED). -c prints one count a file and
// needs no -m. -o prints each match of the lines -m already bounds (measured: twice their bytes at most).
// source: files, stop-reflection-gate.py MAX_LISTED = 5; lines and context, chosen here from the measured line sizes above.
export const GREP_MAX = { lines: 10, context: 2, files: 5 } as const

// The files a grep reads, when the command is that grep; their shape and disk are checked by the caller.
export function grepOperands(command: unknown): string[] | undefined {
  const words = shellWords(command)
  if (words === undefined || words[0] !== 'grep') return undefined
  let i = 1
  let hasE = false
  let counts = false
  let bounded = false
  for (; i < words.length; i++) {
    const w = words[i] ?? ''
    if (GREP_CLUSTER.test(w)) {
      counts ||= w.includes('c')
      continue
    }
    if (GREP_COUNTED.test(w)) {
      const n = words[i + 1] ?? ''
      if (!/^[0-9]{1,2}$/.test(n)) return undefined
      const value = Number(n)
      if (w === '-m' ? value < 1 || value > GREP_MAX.lines : value > GREP_MAX.context) return undefined
      bounded ||= w === '-m'
      i++
    } else if (w === '-e') {
      if (!GREP_PATTERN.test(words[i + 1] ?? '')) return undefined
      hasE = true
      i++
    } else break
  }
  if (!hasE) {
    if (!GREP_PATTERN.test(words[i] ?? '')) return undefined
    i++
  }
  const files = words.slice(i)
  if (!counts && !bounded) return undefined
  return files.length > 0 && files.length <= GREP_MAX.files ? files : undefined
}

// The transcripts a Read or a grep reads, when it reads subagent transcripts of this HOME and nothing else.
export function transcriptsRead(call: Call, home: unknown): string[] | undefined {
  const paths = call.tool === 'Read' ? [call.file_path] : call.tool === 'Bash' ? grepOperands(call.command) : undefined
  if (paths === undefined || !paths.every((p) => isSubagentTranscript(p, home))) return undefined
  return paths as string[]
}

export function isGrepCommand(command: unknown, home: unknown): boolean {
  return transcriptsRead({ tool: 'Bash', command }, home) !== undefined
}

// The shape half of the exemption; register.tsx adds the disk half for the transcripts.
export function isReflectionCall(call: Call, home: unknown): boolean {
  return isLedgerCall(call) || transcriptsRead(call, home) !== undefined
}

export const refusal = (tool: string): string =>
  `delegate: the main loop only delegates, so ${tool} is a subagent's work. Call Agent with the model and effort the task needs.`
