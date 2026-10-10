import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { guard } from './guard.mjs';
import { prepareWorktreeIntent, consumeWorktreeIntent } from './worktree-intents.mjs';
import { record, dataDirectory } from './telemetry.mjs';
const event = process.argv[2];
const context = 'claude-mods for Codex: $cortex reports hook telemetry, $fleet inspects installed plugins and GitHub, $wiki exports a wiki page, $genius recommends a workflow, and $autopilot provides advisory effort guidance. Hooks cannot select the model/effort or render Claude panes. Wiki pages and ADR mirrors require Cortex wiki tools; git worktrees must live inside the real repository worktree roots.';
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
const deny = reason => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
function register(input) {
  const request = consumeWorktreeIntent(input);
  if (!request) return;
  try {
    const script = join(homedir(), 'Developments', 'disk-hygiene', 'disk_hygiene.py');
    if (!existsSync(script)) throw new Error(`Worktree registration failed: missing ${script}`);
    const { repo, path } = request;
    let python;
    for (const candidate of ['python3', 'python', 'py']) {
      if (spawnSync(candidate, ['--version']).status === 0) { python = candidate; break; }
    }
    if (!python) throw new Error('Worktree registration failed: Python is unavailable');
    const result = spawnSync(python, [script, '--host', 'codex', '--session', input.session_id, 'register-worktree', '--repo', repo, '--path', path], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Worktree registration failed: ${result.stderr?.trim() || result.stdout?.trim() || result.error?.message}`);
  } finally {
    request.release();
  }
}
try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (!input || input.hook_event_name !== event || typeof input.session_id !== 'string' || !input.session_id || typeof input.cwd !== 'string') throw new Error('Invalid native hook envelope');
  if (event === 'PreToolUse') {
    let verdict, registrationContext;
    try { verdict = guard(input); if (verdict.allow) registrationContext = prepareWorktreeIntent(input); }
    catch (error) { verdict = { allow: false, rule: 'unresolved-input', reason: error.message }; }
    record(input, verdict.allow ? { outcome: 'observed' } : { outcome: 'denied', rule: verdict.rule });
    output(verdict.allow ? (registrationContext ? { hookSpecificOutput: { hookEventName: event, additionalContext: registrationContext } } : {}) : deny(verdict.reason));
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
