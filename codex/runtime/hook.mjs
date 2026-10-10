import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { guard, worktreeRequest } from './guard.mjs';
import { record, dataDirectory } from './telemetry.mjs';
const event = process.argv[2];
const context = 'claude-mods for Codex: $cortex reports hook telemetry, $fleet inspects installed plugins and GitHub, $wiki exports a wiki page, $genius recommends a workflow, and $autopilot provides advisory effort guidance. Hooks cannot select the model/effort or render Claude panes. Wiki pages and ADR mirrors require Cortex wiki tools; git worktrees must live inside the real repository worktree roots.';
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
const deny = reason => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
function register(input) {
  const args = input.tool_input ?? {}, command = args.command ?? args.cmd;
  if (typeof command !== 'string') return;
  const requests = worktreeRequest(command, args.workdir ?? args.cwd ?? input.cwd);
  if (!requests.length) return;
  const response = input.tool_response;
  // These structured shapes are supported by this adapter; native host delivery
  // remains unverified. Arbitrary stdout is never evidence of process success.
  const exit = response?.exit_code ?? response?.exitCode;
  if (!Number.isInteger(exit)) throw new Error('Worktree registration not verified: host result has no supported exit status; register manually.');
  if (exit !== 0) return;
  const script = join(homedir(), 'Developments', 'disk-hygiene', 'disk_hygiene.py');
  if (!existsSync(script)) throw new Error(`Worktree registration failed: missing ${script}`);
  for (const { repo, path } of requests) {
    let python;
    for (const candidate of ['python3', 'python', 'py']) {
      if (spawnSync(candidate, ['--version']).status === 0) { python = candidate; break; }
    }
    if (!python) throw new Error('Worktree registration failed: Python is unavailable');
    const result = spawnSync(python, [script, '--host', 'codex', '--session', input.session_id, 'register-worktree', '--repo', repo, '--path', path], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Worktree registration failed: ${result.stderr?.trim() || result.stdout?.trim() || result.error?.message}`);
  }
}
try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (!input || input.hook_event_name !== event || typeof input.session_id !== 'string' || !input.session_id || typeof input.cwd !== 'string') throw new Error('Invalid native hook envelope');
  if (event === 'PreToolUse') {
    let verdict;
    try { verdict = guard(input); } catch (error) { verdict = { allow: false, rule: 'unresolved-input', reason: error.message }; }
    record(input, verdict.allow ? { outcome: 'observed' } : { outcome: 'denied', rule: verdict.rule });
    output(verdict.allow ? {} : deny(verdict.reason));
  } else if (event === 'PostToolUse') {
    try { register(input); record(input, { outcome: 'observed' }); output({}); }
    catch (error) { record(input, { outcome: 'registration-error' }); output({ hookSpecificOutput: { hookEventName: event, additionalContext: error.message } }); }
  } else {
    record(input);
    const locations = { plugin_root: fileURLToPath(new URL('../', import.meta.url)), plugin_data: dataDirectory(), session_id: input.session_id };
    output(['SessionStart', 'UserPromptSubmit'].includes(event) ? { hookSpecificOutput: { hookEventName: event, additionalContext: context + '\nRuntime locations (literal values; hook environment may not persist in tool shells): ' + JSON.stringify(locations) } } : {});
  }
} catch (error) {
  // Malformed guarded requests must not become a fail-open hook crash.
  if (event === 'PreToolUse') output(deny(`claude-mods could not validate the request: ${error.message}`));
  else { process.stderr.write(`claude-mods hook: ${error.message}\n`); process.exitCode = 1; }
}
