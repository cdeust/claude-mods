// Node's documented stripTypeScriptTypes API; explicit source map avoids bundler dependencies.
// https://nodejs.org/api/module.html#modulestriptypescripttypescode-options
import { stripTypeScriptTypes } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const sources = {
  guard: 'cortex-guard/hooks/guard.ts', rules: 'cortex-guard/hooks/rules.ts',
  wiki: 'cortex-wiki/hooks/wiki.ts', classify: 'zetetic-genius/hooks/classify.ts',
  genius: 'zetetic-genius/hooks/genius.ts',
  fleet: 'harness-fleet/hooks/fleet.ts',
};
let stale = false;
for (const [name, source] of Object.entries(sources)) {
  const input = new URL(`mods/${source}`, root);
  const target = new URL(`codex/shared/${name}.mjs`, root);
  const code = stripTypeScriptTypes(await readFile(input, 'utf8'), { mode: 'transform' })
    .replace("from './rules'", "from './rules.mjs'");
  const output = `// Generated from mods/${source}; run npm run build:codex.\n${code}`;
  if (process.argv.includes('--check')) {
    let actual; try { actual = await readFile(target, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (actual !== output) { console.error(`stale: ${fileURLToPath(target)}`); stale = true; }
  } else { await mkdir(new URL('./', target), { recursive: true }); await writeFile(target, output); }
}
if (stale) process.exitCode = 1;
