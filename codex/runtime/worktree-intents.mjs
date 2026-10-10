import { lstatSync, realpathSync, statSync, mkdirSync, writeFileSync, readFileSync, linkSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dataDirectory } from './telemetry.mjs';
import { physicalPath, worktreeRequest } from './guard.mjs';

// Codex rust-v0.162.1 core/tests/suite/hooks.rs:5453-5461 exposes shell
// tool_response as raw text. Ownership is instead proved across the native
// tool_use_id boundary and Git's filesystem metadata; stdout is never inspected.
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unverified = detail => `Worktree registration not verified: ${detail}; register manually.`;
function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Cannot inspect Git ownership: ${result.stderr?.trim() || result.error?.message}`);
  return result.stdout;
}
function commonIdentity(repo) {
  const path = realpathSync(git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  const info = statSync(path);
  return { path, dev: info.dev, ino: info.ino };
}
function registered(repo, path) {
  return git(repo, ['worktree', 'list', '--porcelain', '-z']).split('\0')
    .filter(field => field.startsWith('worktree '))
    .some(field => physicalPath(field.slice(9), repo) === path);
}
function exists(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function requests(input) {
  const name = input.tool_name;
  if (typeof name !== 'string' || (!['Bash', 'exec_command', 'shell_command'].includes(name) && !name.endsWith('__exec_command'))) return [];
  const args = input.tool_input ?? {}, command = args.command ?? args.cmd;
  return typeof command === 'string' ? worktreeRequest(command) : [];
}
function locations(input, request) {
  const root = join(dataDirectory(), 'worktree-intents');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const owner = digest([input.session_id, input.tool_use_id]);
  return { owner, pending: join(root, `${owner}.pending.json`), reservation: join(root, `${digest([request.repo, request.path])}.reservation.json`) };
}

export function prepareWorktreeIntent(input) {
  const candidates = requests(input);
  if (!candidates.length) return;
  if (typeof input.tool_use_id !== 'string' || !input.tool_use_id) return unverified('missing native tool_use_id');
  // The literal-command grammar permits a single worktree add per tool call.
  if (candidates.length !== 1) throw new Error('Expected exactly one worktree request');
  const request = candidates[0], paths = locations(input, request);
  const intent = { session_id: input.session_id, tool_use_id: input.tool_use_id, ...request, common: commonIdentity(request.repo) };
  writeFileSync(paths.pending, JSON.stringify(intent), { flag: 'wx', mode: 0o600 });
  try { linkSync(paths.pending, paths.reservation); }
  catch (error) {
    unlinkSync(paths.pending);
    if (error.code === 'EEXIST') throw new Error('Another native call already reserved this worktree target; this competing creation is denied.');
    throw error;
  }
  try {
    // Check after acquiring the target reservation to exclude simultaneous
    // native calls. Existing directories and stale registered paths are never claimed.
    if (exists(request.path) || registered(request.repo, request.path)) {
      unlinkSync(paths.pending);
      unlinkSync(paths.reservation);
      return unverified('target existed before the tool call');
    }
  } catch (error) {
    if (exists(paths.pending)) unlinkSync(paths.pending);
    if (exists(paths.reservation)) unlinkSync(paths.reservation);
    throw error;
  }
}

export function consumeWorktreeIntent(input) {
  const candidates = requests(input);
  if (!candidates.length) return;
  if (typeof input.tool_use_id !== 'string' || !input.tool_use_id) throw new Error(unverified('missing native tool_use_id'));
  if (candidates.length !== 1) throw new Error('Expected exactly one worktree request');
  const request = candidates[0], paths = locations(input, request);
  const claimed = `${paths.pending}.claimed-${randomUUID()}`;
  try { renameSync(paths.pending, claimed); }
  catch (error) { if (error.code === 'ENOENT') throw new Error(unverified('no pending intent for this native call')); throw error; }
  const intent = JSON.parse(readFileSync(claimed, 'utf8'));
  const reservation = JSON.parse(readFileSync(paths.reservation, 'utf8'));
  if (intent.session_id !== input.session_id || intent.tool_use_id !== input.tool_use_id || intent.repo !== request.repo || intent.path !== request.path || JSON.stringify(reservation) !== JSON.stringify(intent))
    throw new Error(unverified('native call or reserved target identity changed'));
  // The reservation stays held through verification AND hygiene registration.
  // Its consumed intent remains an audit receipt, including on failure.
  const release = () => {
    const owner = JSON.parse(readFileSync(paths.reservation, 'utf8'));
    if (JSON.stringify(owner) !== JSON.stringify(intent)) throw new Error('Cannot release worktree reservation: ownership changed');
    unlinkSync(paths.reservation);
  };
  try {
    if (!exists(intent.path) || !registered(intent.repo, intent.path)) throw new Error(unverified('no new registered worktree found'));
    const common = commonIdentity(intent.repo), targetCommon = commonIdentity(intent.path);
    if (JSON.stringify(common) !== JSON.stringify(intent.common) || JSON.stringify(targetCommon) !== JSON.stringify(intent.common))
      throw new Error(unverified('Git common-directory identity changed'));
    return { repo: intent.repo, path: intent.path, release };
  } catch (error) {
    try { release(); } catch (cleanup) { throw new Error(`${error.message}; reservation release failed: ${cleanup.message}`); }
    throw error;
  }
}
