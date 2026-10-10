import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const cli = new URL('../commands/mods.mjs', import.meta.url);
const run = (args, environment = {}, cwd) => spawnSync(process.execPath, [cli.pathname, ...args], { encoding:'utf8', env:Object.assign({},process['env'],environment), cwd });
test('autopilot recommends shared taxonomy without claiming enforcement', () => {
  const r = run(['autopilot','critical']); assert.equal(r.status,0,r.stderr);
  const d = JSON.parse(r.stdout); assert.equal(d.effort,'high'); assert.equal(d.enforced,false);
});
test('wiki rejects parent escapes before invoking renderer', () => {
  const r = run(['wiki','wiki/../secret.md','out.pdf']); assert.notEqual(r.status,0); assert.match(r.stderr,/no ".."/);
});
test('cortex preserves unmeasured usage', () => {
  const r = run(['cortex']); assert.equal(r.status,0,r.stderr); const d=JSON.parse(r.stdout);
  assert.equal(d.usage,null); assert.equal(d.nativePanels,false);
});
test('fleet reports CLI failures instead of empty readings', () => {
  const dir=mkdtempSync(join(tmpdir(),'mods-command-'));
  try { const bin=join(dir,'bin'); mkdirSync(bin); writeFileSync(join(bin,'codex'),'#!/bin/sh\necho catalog-unavailable >&2\nexit 1\n',{mode:0o755});
    const r=run(['fleet'],{PATH:bin}); assert.equal(r.status,0,r.stderr); const d=JSON.parse(r.stdout);
    assert.match(d.plugins.error,/catalog-unavailable/); assert.equal(d.plugins.value,null);
  } finally {rmSync(dir,{recursive:true});}
});
test('genius reads explicit index without Claude installation', () => {
  const dir=mkdtempSync(join(tmpdir(),'mods-genius-'));
  try { const path=join(dir,'INDEX.md'); writeFileSync(path,'| **inversion** | reverse constraints | [invert](invert.md) | reason backwards |\n');
    const r=run(['genius',path]); assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).patterns[0].shape,'inversion');
  } finally {rmSync(dir,{recursive:true});}
});
