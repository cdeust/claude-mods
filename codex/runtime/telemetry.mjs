import { appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
export const sessionFile = sessionId => `${createHash('sha256').update(sessionId).digest('hex')}.jsonl`;
export function dataDirectory(env = process.env) {
  if (!env.PLUGIN_DATA || !isAbsolute(env.PLUGIN_DATA)) throw new Error('PLUGIN_DATA must be an absolute directory supplied by Codex');
  return env.PLUGIN_DATA;
}
export function record(input, fields = {}) {
  const directory = join(dataDirectory(), 'sessions');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const event = { at: new Date().toISOString(), event: input.hook_event_name, session_id: input.session_id, cwd: input.cwd };
  if (typeof input.turn_id === 'string') event.turn_id = input.turn_id;
  if (typeof input.tool_name === 'string') event.tool = input.tool_name;
  if (typeof input.model === 'string') event.model = input.model;
  // One append syscall per event avoids concurrent read-modify-write races.
  appendFileSync(join(directory, sessionFile(input.session_id)), JSON.stringify({ ...event, ...fields }) + '\n', { mode: 0o600 });
}
