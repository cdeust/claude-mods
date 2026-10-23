// Packaged-plugin process E2E. This invokes real shipped entrypoints, not the Codex host.
// Sources: codex/.codex-plugin/plugin.json, hooks/hooks.json and skills/autopilot/SKILL.md.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../codex');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'claude-mods-e2e-')));
const plugin = join(scratch, 'installed plugin');
const project = join(scratch, 'project');
const data = join(scratch, 'plugin-data');
const session = 'packaged-plugin-e2e';
const privatePrompt = 'E2E_PRIVATE_PROMPT';
const privateContent = 'E2E_PRIVATE_FILE_CONTENT';
const privateResult = 'E2E_PRIVATE_TOOL_RESULT';

function packagedPath(path) {
  const result = realpathSync(resolve(plugin, path));
  const part = relative(plugin, result);
  assert.ok(part && !part.startsWith('..') && !isAbsolute(part), `Path leaves package: ${path}`);
  return result;
}

function processJson(command, args, input) {
  const result = spawnSync(command, args, {
    cwd: project,
    env: { ...process.env, PLUGIN_ROOT: plugin, PLUGIN_DATA: data },
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function hooksRunner(manifest) {
  const definitions = JSON.parse(readFileSync(packagedPath(manifest.hooks), 'utf8')).hooks;
  return (event, fields = {}) => {
    const groups = definitions[event];
    assert.ok(Array.isArray(groups) && groups.length, `Missing ${event} hook`);
    const commands = groups.flatMap(group => group.hooks);
    assert.equal(commands.length, 1, `Expected the shipped single ${event} entrypoint`);
    const hook = commands[0];
    assert.equal(hook.type, 'command');
    assert.ok(hook.command.includes('${PLUGIN_ROOT}'), 'Hook must resolve the copied package');
    return processJson('bash', ['-eo', 'pipefail', '-c', hook.command], {
      session_id: session,
      cwd: project,
      hook_event_name: event,
      ...fields,
    });
  };
}

function writeThroughHooks(hook, path, content, id) {
  const request = { tool_name: 'Write', tool_use_id: id, tool_input: { file_path: path, content } };
  const before = hook('PreToolUse', request);
  if (before.hookSpecificOutput?.permissionDecision !== 'deny') {
    // Perform the real tool effect only after the shipped guard permits it.
    writeFileSync(join(project, path), content);
    assert.deepEqual(hook('PostToolUse', { ...request, tool_response: privateResult }), {});
  }
  return before;
}

function verifyTelemetry() {
  const filename = createHash('sha256').update(session).digest('hex') + '.jsonl';
  const directory = join(data, 'sessions');
  assert.deepEqual(readdirSync(directory), [filename]);
  const text = readFileSync(join(directory, filename), 'utf8');
  const events = text.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.event), [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreToolUse',
  ]);
  assert.ok(events.every(event => event.session_id === session && event.cwd === project));
  assert.deepEqual(events.slice(2).map(event => event.outcome), ['observed', 'observed', 'denied']);
  assert.equal(events.at(-1).rule, 'wiki-write-only');
  for (const secret of [privatePrompt, privateContent, privateResult]) {
    assert.ok(!text.includes(secret), 'Telemetry retained private request content');
  }
  for (const event of events) {
    for (const field of ['prompt', 'tool_input', 'tool_response']) assert.ok(!(field in event));
  }
}

try {
  // No dependency on the source checkout's sibling mods/ or scripts/ is copied.
  cpSync(source, plugin, { recursive: true });
  mkdirSync(join(project, 'wiki/adr'), { recursive: true });
  writeFileSync(join(project, 'README.md'), 'before');
  writeFileSync(join(project, 'wiki/adr/protected.md'), 'canonical content');
  const manifest = JSON.parse(readFileSync(join(plugin, '.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'claude-mods');
  const hook = hooksRunner(manifest);
  const start = hook('SessionStart').hookSpecificOutput;
  assert.equal(start.hookEventName, 'SessionStart');
  assert.ok(start.additionalContext.includes(plugin), 'Session context must name the copied package');
  assert.match(start.additionalContext, /advisory/);
  assert.equal(hook('UserPromptSubmit', { prompt: privatePrompt }).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.deepEqual(writeThroughHooks(hook, 'README.md', privateContent, 'allowed-write'), {});
  assert.equal(readFileSync(join(project, 'README.md'), 'utf8'), privateContent);
  const denied = writeThroughHooks(hook, 'wiki/adr/protected.md', privateContent, 'denied-write');
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(readFileSync(join(project, 'wiki/adr/protected.md'), 'utf8'), 'canonical content');
  verifyTelemetry();

  const skills = packagedPath(manifest.skills);
  const autopilot = readdirSync(skills).map(name => join(skills, name)).find(directory => {
    const file = join(directory, 'SKILL.md');
    return existsSync(file) && /^name: autopilot$/m.test(readFileSync(file, 'utf8'));
  });
  assert.ok(autopilot, 'Packaged autopilot skill is missing');
  const skillText = readFileSync(join(autopilot, 'SKILL.md'), 'utf8');
  assert.ok(skillText.includes('scripts/run.mjs'), 'Skill must document its process entrypoint');
  const command = packagedPath(relative(plugin, join(autopilot, 'scripts/run.mjs')));
  const guidance = processJson(process.execPath, [command, 'critical']);
  assert.equal(guidance.taskClass, 'critical');
  assert.equal(guidance.effort, 'high');
  assert.equal(guidance.mode, 'advisory');
  assert.equal(guidance.enforced, false);
  console.log('Packaged plugin E2E passed: session, guarded file edit, telemetry and autopilot CLI.');
  console.log('Boundary: copied plugin processes; Codex host discovery and hook trust are not exercised.');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
