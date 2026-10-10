// Host adapter: commands own their output; they do not intercept native tool results.
import { readFile, mkdtemp, writeFile, rm, realpath, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { wikiTarget, toPandocSource, pandocArgv } from '../shared/wiki.mjs';
import { TASK_CLASSES, effortForClass, classifierSystem, parseShapes } from '../shared/classify.mjs';
import { parseGeniusIndex } from '../shared/genius.mjs';
import { prListArgv, issueListArgv, parsePrList, parseIssues, PR_LIMIT, ISSUE_LIMIT, prCountArgv, parsePrCount } from '../shared/fleet.mjs';

const environment = process['env'];
const output = (value) => console.log(JSON.stringify(value, null, 2));
const run = (argv) => {
  const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${argv[0]} exited ${result.status}: ${result.stderr.trim()}`);
  return result.stdout;
};
const reading = (fn) => { try { return { value: fn(), error: null }; } catch (e) { return { value: null, error: e.message }; } };

async function cortex(sessionId) {
  let events = null, error = null;
  if (sessionId && environment.PLUGIN_DATA) {
    const id = createHash('sha256').update(sessionId).digest('hex');
    try { events = (await readFile(join(environment.PLUGIN_DATA,'sessions',`${id}.jsonl`),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (e) { error = e.message; }
  } else error = 'Pass a session id and PLUGIN_DATA to read this plugin’s recorded hooks.';
  return { host:'codex', sessionId:sessionId ?? null, events, error, usage:null, quotas:null, nativePanels:false,
    routing:{mode:'advisory', enforced:false}, note:'Hook events prove observations only. Usage, quotas and UI panels are not exposed by this adapter.' };
}

async function wiki(path, outputPath) {
  const target = wikiTarget(path ?? '');
  if (!target.ok) throw new Error(target.reason);
  if (!outputPath || !outputPath.endsWith('.pdf')) throw new Error('usage: wiki <wiki/page.md> <new-output.pdf>');
  const source = await realpath(resolve(target.path));
  if (!wikiTarget(source).ok) throw new Error('source resolves outside a wiki Markdown path');
  const destination = resolve(outputPath);
  try { await lstat(destination); throw new Error(`output already exists: ${destination}`); } catch(e) { if(e.code !== 'ENOENT') throw e; }
  // Keep scratch under the OS temporary directory; pandoc never runs on shell-expanded input.
  const scratch = await mkdtemp(join(tmpdir(),'claude-mods-wiki-'));
  try {
    const markdown = join(scratch,'page.md');
    await writeFile(markdown,toPandocSource(await readFile(source,'utf8')));
    // Produce scratch PDF first and copy exclusively, preserving any concurrently created output.
    const pdf = join(scratch,'page.pdf');
    run(pandocArgv(markdown,pdf));
    await writeFile(destination,await readFile(pdf),{flag:'wx'});
    return {source,output:destination,opened:false};
  } finally { await rm(scratch,{recursive:true}); }
}

function fleet(repos) {
  const plugins = reading(() => JSON.parse(run(['codex','plugin','list','--json'])));
  const repositories = repos.map(repo => {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`expected owner/repo: ${repo}`);
    const prs = reading(() => parsePrList(run(prListArgv(repo))));
    const issues = reading(() => parseIssues(run(issueListArgv(repo))));
    const total = prs.value === null ? {value:null,error:prs.error} : prs.value.length > PR_LIMIT
      ? reading(() => parsePrCount(run(prCountArgv(repo)))) : {value:prs.value.length,error:null};
    return {repo,prs:{value:prs.value?.slice(0,PR_LIMIT) ?? null,error:prs.error},prTotal:total,
      issues,issuesMayBeTruncated:issues.value === null ? null : issues.value.length === ISSUE_LIMIT};
  });
  return {readOnly:true,plugins,repositories};
}

async function genius(index, shapeTable) {
  const patterns = index ? parseGeniusIndex(await readFile(resolve(index),'utf8')) : [];
  const shapes = shapeTable ? parseShapes(await readFile(resolve(shapeTable),'utf8')) : [];
  return {patterns,shapes,classificationPrompt:classifierSystem(shapes,patterns),
    mode:'guidance', note:'Classify the actual request using the supplied patterns. No extra paid completion runs automatically; no native model setting is changed.'};
}

export async function main(args) {
  try {
    const [command,...rest] = args;
    switch(command) {
      case 'cortex': output(await cortex(rest[0])); break;
      case 'wiki': output(await wiki(...rest)); break;
      case 'fleet': output(fleet(rest)); break;
      case 'genius': output(await genius(...rest)); break;
      case 'autopilot': {
        const taskClass = rest[0];
        if(!TASK_CLASSES.includes(taskClass)) throw new Error(`task class must be one of ${TASK_CLASSES.join(', ')}`);
        output({taskClass,effort:effortForClass(taskClass),enforced:false,mode:'advisory',
          note:'The effort table is shared with Claude. Codex hooks cannot change root model/effort at every inference step. Select model and effort in the host before the next turn.'}); break;
      }
      default: throw new Error('usage: mods.mjs cortex [session-id] | wiki <wiki/page.md> <new.pdf> | fleet [owner/repo ...] | genius [INDEX.md] [routing-table.md] | autopilot <task-class>');
    }
  } catch(e) { console.error(e.message); process.exitCode=1; }
}
if(process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
