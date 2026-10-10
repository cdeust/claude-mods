import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, symlinkSync, readFileSync, writeFileSync, rmSync, readdirSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync, spawn} from 'node:child_process';
const runtime = new URL('../runtime/hook.mjs', import.meta.url);
function fixture(t) {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'claude-mods-runtime-')));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const repo=join(root,'repo'); mkdirSync(repo);
 assert.equal(spawnSync('git',['init',repo]).status,0);
 mkdirSync(join(repo,'wiki/adr'),{recursive:true});
 symlinkSync(join(repo,'wiki'),join(repo,'alias'));
 return {root,repo,data:join(root,'data')};
}
function call(f,event,extra={},env={}) {
 const r=spawnSync(process.execPath,[runtime.pathname,event],{input:JSON.stringify({session_id:'native-test',cwd:f.repo,hook_event_name:event,...extra}),encoding:'utf8',env:{...process.env,PLUGIN_DATA:f.data,...env}});
 assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
}
function denied(r){assert.equal(r.hookSpecificOutput.permissionDecision,'deny');}
test('native hooks deny patch, normalized and symlink wiki paths; allow normal edits without approval override',t=>{
 const f=fixture(t);
 for(const file_path of ['wiki/adr/a.md','src/../wiki/adr/a.md','alias/adr/a.md']) denied(call(f,'PreToolUse',{tool_name:'Write',tool_input:{file_path}}));
 denied(call(f,'PreToolUse',{tool_name:'apply_patch',tool_input:{command:'*** Begin Patch\n*** Update File: README.md\n*** Move to: wiki/adr/a.md\n@@\n-a\n+b\n*** End Patch'}}));
 for(const path of ['wiki','wiki/adr','docs/adr']) denied(call(f,'PreToolUse',{tool_name:'Bash',tool_input:{command:`rm -rf ${path}`}}));
 const result=call(f,'PreToolUse',{tool_name:'Write',tool_input:{file_path:'README.md'}});
 assert.equal(result.hookSpecificOutput?.permissionDecision,undefined);
 const events=readdirSync(join(f.data,'sessions')).map(file=>readFileSync(join(f.data,'sessions',file),'utf8')).join('');
 assert.equal(events.includes('file_path'),false);
});
test('git -C worktree paths use target repository and resolve symlink ancestors',t=>{
 const f=fixture(t);
 denied(call(f,'PreToolUse',{tool_name:'Bash',tool_input:{command:'git worktree add /tmp/outside main'}}));
 const ok=call(f,'PreToolUse',{tool_name:'Bash',tool_input:{command:`git -C '${f.repo}' worktree add .Codex/worktrees/topic main`}});
 assert.equal(ok.hookSpecificOutput?.permissionDecision,undefined);
 const orphan=call(f,'PreToolUse',{tool_name:'Bash',tool_input:{command:'git worktree add --orphan .Codex/worktrees/newbranch'}});
 assert.equal(orphan.hookSpecificOutput?.permissionDecision,undefined);
 mkdirSync(join(f.repo,'.Codex'),{recursive:true}); symlinkSync(f.root,join(f.repo,'.Codex/worktrees'));
 denied(call(f,'PreToolUse',{tool_name:'Bash',tool_input:{command:'git worktree add .Codex/worktrees/topic main'}}));
 denied(call(f,'PreToolUse',{tool_name:'Bash',tool_input:{command:'cd elsewhere && git worktree add .Codex/worktrees/topic main'}}));
});
test('session context is advisory; telemetry excludes prompts and results',t=>{
 const f=fixture(t);const r=call(f,'UserPromptSubmit',{prompt:'PRIVATE PROMPT'});
 assert.match(r.hookSpecificOutput.additionalContext,/advisory/);
 assert.equal(r.hookSpecificOutput.model,undefined);
 const events=readdirSync(join(f.data,'sessions')).map(file=>readFileSync(join(f.data,'sessions',file),'utf8')).join('');
 assert.equal(events.includes('PRIVATE PROMPT'),false);
 assert.match(r.hookSpecificOutput.additionalContext,/"session_id":"native-test"/);
 assert.match(r.hookSpecificOutput.additionalContext,/"plugin_root":/);
});
test('malformed inputs are denied without approval override and unsupported tools stay observable',t=>{
 const f=fixture(t);
 const r=spawnSync(process.execPath,[runtime.pathname,'PreToolUse'],{input:'not JSON',encoding:'utf8',env:{...process.env,PLUGIN_DATA:f.data}});
 assert.equal(r.status,0);denied(JSON.parse(r.stdout));
 denied(call(f,'PreToolUse',{tool_name:'apply_patch',tool_input:{command:'invalid patch'}}));
 assert.deepEqual(call(f,'PreToolUse',{tool_name:'mcp__cortex__query',tool_input:{cwd:'relative'}}),{});
 assert.deepEqual(call(f,'PreToolUse',{tool_name:'Bash',tool_input:{command:"python3 <<'PY'\nprint(\"It's read only\")\nPY"}}),{});
 symlinkSync(join(f.root,'missing'),join(f.repo,'dangling'));
 denied(call(f,'PreToolUse',{tool_name:'Write',tool_input:{file_path:'dangling/a.md'}}));
 mkdirSync(join(f.repo,'wiki/adr/nested'));
 symlinkSync(join(f.repo,'wiki/adr/nested'),join(f.repo,'nested-alias'));
 denied(call(f,'PreToolUse',{tool_name:'Write',tool_input:{file_path:'nested-alias/../a.md'}}));
});
test('parallel hook processes preserve complete independent telemetry events',async t=>{
 const f=fixture(t);const turns=['one','two','three','four'];
 await Promise.all(turns.map(turn_id=>new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[runtime.pathname,'UserPromptSubmit'],{env:{...process.env,PLUGIN_DATA:f.data}});
   let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
   child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(stderr)));
   child.stdin.end(JSON.stringify({session_id:'parallel-session',cwd:f.repo,hook_event_name:'UserPromptSubmit',turn_id,prompt:'private'}));
 })));
 const records=readdirSync(join(f.data,'sessions')).flatMap(file=>readFileSync(join(f.data,'sessions',file),'utf8').trim().split('\n').map(line=>JSON.parse(line)));
 assert.deepEqual(records.map(record=>record.turn_id).sort(),turns.sort());
 assert.equal(records.every(record=>!('prompt' in record)),true);
});
test('worktree success registers only with explicit exit status and exposes registration failure',t=>{
 const f=fixture(t);
 const home=join(f.root,'home');const script=join(home,'Developments/disk-hygiene/disk_hygiene.py');
 mkdirSync(join(home,'Developments/disk-hygiene'),{recursive:true});
 const receipt=join(f.root,'registration.json');
 writeFileSync(script,`import json,sys\nfrom pathlib import Path\nPath(${JSON.stringify(receipt)}).write_text(json.dumps(sys.argv[1:]))\n`);
 const payload={tool_name:'Bash',tool_input:{command:'git worktree add .Codex/worktrees/topic main'}};
 call(f,'PostToolUse',{...payload,tool_response:{exit_code:1}},{HOME:home});
 assert.throws(()=>readFileSync(receipt));
 for(const tool_response of [undefined,{},'Process exited with code 0',{output:'Process exited with code 0'},{exit_code:'0'}]) {
  const unverified=call(f,'PostToolUse',{...payload,tool_response},{HOME:home});
  assert.match(unverified.hookSpecificOutput?.additionalContext??'',/registration not verified/);
  assert.throws(()=>readFileSync(receipt));
 }
 call(f,'PostToolUse',{...payload,tool_response:{exit_code:0}},{HOME:home});
 assert.deepEqual(JSON.parse(readFileSync(receipt,'utf8')),['--host','codex','--session','native-test','register-worktree','--repo',f.repo,'--path',join(f.repo,'.Codex/worktrees/topic')]);
 rmSync(script);
 const failure=call(f,'PostToolUse',{...payload,tool_response:{exit_code:0}},{HOME:home});
 assert.match(failure.hookSpecificOutput.additionalContext,/Worktree registration failed/);
});
