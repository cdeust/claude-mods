import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, symlinkSync, readFileSync, writeFileSync, rmSync, readdirSync, realpathSync, renameSync} from 'node:fs';
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
let nextTool = 0;
function call(f,event,extra={},env={}) {
 const r=spawnSync(process.execPath,[runtime.pathname,event],{input:JSON.stringify({session_id:'native-test',tool_use_id:`tool-${nextTool++}`,cwd:f.repo,hook_event_name:event,...extra}),encoding:'utf8',env:{...process.env,PLUGIN_DATA:f.data,...env}});
 assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
}
function denied(r){assert.equal(r.hookSpecificOutput.permissionDecision,'deny');}
function registrar(f) {
 const home=join(f.root,'home');const script=join(home,'Developments/disk-hygiene/disk_hygiene.py');
 mkdirSync(join(home,'Developments/disk-hygiene'),{recursive:true});
 const receipt=join(f.root,'registration.json');
 writeFileSync(script,`import json,sys\nfrom pathlib import Path\nassert len(list(Path(${JSON.stringify(join(f.data,'worktree-intents'))}).glob('*.reservation.json'))) == 1, 'reservation released before registration'\nPath(${JSON.stringify(receipt)}).write_text(json.dumps(sys.argv[1:]))\n`);
 return {env:{HOME:home},receipt,script};
}
function addWorktree(f,path) {
 const result=spawnSync('git',['worktree','add','--orphan',path],{cwd:f.repo,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
}
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
 const orphan=call(f,'PreToolUse',{tool_name:'Bash',tool_input:{command:`git -C '${f.repo}' worktree add --orphan .Codex/worktrees/newbranch`}});
 assert.equal(orphan.hookSpecificOutput?.permissionDecision,undefined);
 mkdirSync(join(f.repo,'.Codex'),{recursive:true}); symlinkSync(f.root,join(f.repo,'.Codex/worktrees'));
 denied(call(f,'PreToolUse',{tool_name:'Bash',tool_input:{command:`git -C '${f.repo}' worktree add .Codex/worktrees/topic main`}}));
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
test('native Bash omission of workdir requires explicit absolute git -C',t=>{
 const f=fixture(t);const repoB=join(f.root,'other-repo');
 assert.equal(spawnSync('git',['init',repoB]).status,0);
 // The host executes in repoB, but its native hook envelope only carries repoA.
 const r=call(f,'PreToolUse',{tool_name:'Bash',tool_input:{command:`git worktree add '${f.repo}/.Codex/worktrees/wrong-repo' main`}});
 denied(r);
 assert.match(r.hookSpecificOutput.permissionDecisionReason,/absolute.*-C|-C.*absolute/);
 denied(call(f,'PreToolUse',{tool_name:'Bash',tool_input:{command:'git -C . worktree add .Codex/worktrees/relative main',workdir:repoB}}));
});
test('quoted script data and heredoc bodies never become filesystem operands',t=>{
 const f=fixture(t);const data='x'.repeat(300)+' > wiki/adr/a.md';
 const commands=[
  `python3 -c 'print("${data}")'`,
  `python3 - <<'PY'\nprint("${data}")\nPY\n`,
  `python3 - <<PY\nprint("${data}")\nPY\n`,
  `cat <<FIRST <<'SECOND'\n${data}\nFIRST\nrm wiki/adr/a.md\nSECOND\n`,
  `cat <<-EOF\n\t${data}\n\tEOF\n`,
  `printf '%s' '> wiki/adr/a.md' # rm wiki/adr/a.md\n`,
  `git -C . log --grep='worktree add'`,
  `node -e 'console.log("${data}")'`,
  `printf '%s' "$(printf '%s' '${data}')"`,
 ];
 for(const command of commands) {
  const syntax=spawnSync('/bin/bash',['-n'],{input:command,encoding:'utf8'});
  assert.equal(syntax.status,0,syntax.stderr);
  assert.deepEqual(call(f,'PreToolUse',{tool_name:'Bash',tool_input:{command}}),{},command);
 }
});
test('actual redirections and file-writing operands remain guarded',t=>{
 const f=fixture(t);
 for(const command of [
  "printf '%s' safe > wiki/adr/a.md",
  "cat <<'EOF' > wiki/adr/a.md\nsafe\nEOF\n",
  "cat <<'EOF'\nsafe\nEOF\nprintf safe >> wiki/adr/a.md\n",
  "tee 'alias/adr/a.md'", "mv README.md wiki/adr/a.md", "cp README.md wiki/adr/a.md",
  "sed -i '' 's/a/b/' wiki/adr/a.md", "perl -pi -e 's/a/b/' wiki/adr/a.md",
  "sed -i --expression='s/a/b/' wiki/adr/a.md", "printf safe 2> wiki/adr/a.md",
  "dd if=README.md of=wiki/adr/a.md", "printf safe >", "tee 'unfinished",
  "if true; then rm wiki/adr/a.md; fi", "{ rm wiki/adr/a.md; }",
  "command rm wiki/adr/a.md", "env rm wiki/adr/a.md",
  "env -i command -p rm wiki/adr/a.md",
  "while rm wiki/adr/a.md; do break; done", "until rm wiki/adr/a.md; do break; done",
  "time rm wiki/adr/a.md", "time -p rm wiki/adr/a.md",
 ]) denied(call(f,'PreToolUse',{tool_name:'Bash',tool_input:{command}}));
 assert.deepEqual(call(f,'PreToolUse',{tool_name:'Bash',tool_input:{command:"cp wiki/adr/a.md README-copy.md"}}),{});
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
test('real Git worktree creation registers from paired native hooks regardless of raw output',t=>{
 const f=fixture(t);
 const {env,receipt}=registrar(f);
 const payload={tool_name:'Bash',tool_use_id:'created-worktree',tool_input:{command:`git -C '${f.repo}' worktree add --orphan .Codex/worktrees/topic`}};
 assert.deepEqual(call(f,'PreToolUse',payload,env),{});
 addWorktree(f,'.Codex/worktrees/topic');
 assert.deepEqual(call(f,'PostToolUse',{...payload,tool_response:'Preparing worktree (new branch)'},env),{});
 assert.deepEqual(JSON.parse(readFileSync(receipt,'utf8')),['--host','codex','--session','native-test','register-worktree','--repo',f.repo,'--path',join(f.repo,'.Codex/worktrees/topic')]);
 assert.equal(readdirSync(join(f.data,'worktree-intents')).some(file=>file.endsWith('.reservation.json')),false);
 rmSync(receipt);
 const duplicate=call(f,'PostToolUse',{...payload,tool_response:'Preparing worktree (new branch)'},env);
 assert.match(duplicate.hookSpecificOutput.additionalContext,/registration not verified/);
 assert.throws(()=>readFileSync(receipt));
});
test('spoofed success and failed Git do not register an absent worktree',t=>{
 const f=fixture(t);const {env,receipt}=registrar(f);
 const payload={tool_name:'Bash',tool_use_id:'failed-worktree',tool_input:{command:`git -C '${f.repo}' worktree add .Codex/worktrees/failed missing-reference`}};
 assert.deepEqual(call(f,'PreToolUse',payload,env),{});
 const git=spawnSync('git',['worktree','add','.Codex/worktrees/failed','missing-reference'],{cwd:f.repo,encoding:'utf8'});
 assert.notEqual(git.status,0);
 const result=call(f,'PostToolUse',{...payload,tool_response:'Process exited with code 0'},env);
 assert.match(result.hookSpecificOutput.additionalContext,/no new registered worktree found/);
 assert.throws(()=>readFileSync(receipt));
});
test('preexisting paths and unpaired native calls cannot claim ownership',t=>{
 const f=fixture(t);const {env,receipt}=registrar(f);
 addWorktree(f,'.Codex/worktrees/existing');
 const payload={tool_name:'Bash',tool_use_id:'existing-worktree',tool_input:{command:`git -C '${f.repo}' worktree add --orphan .Codex/worktrees/existing`}};
 const pre=call(f,'PreToolUse',payload,env);
 assert.match(pre.hookSpecificOutput.additionalContext,/target existed before/);
 for(const tool_use_id of [payload.tool_use_id,'unpaired-call']) {
  const result=call(f,'PostToolUse',{...payload,tool_use_id,tool_response:{exit_code:0}},env);
  assert.match(result.hookSpecificOutput.additionalContext,/no pending intent/);
  assert.throws(()=>readFileSync(receipt));
 }
 mkdirSync(join(f.repo,'.Codex/worktrees/empty'));
 const empty=call(f,'PreToolUse',{...payload,tool_use_id:'empty-directory',tool_input:{command:`git -C '${f.repo}' worktree add --orphan .Codex/worktrees/empty`}},env);
 assert.match(empty.hookSpecificOutput.additionalContext,/target existed before/);
});
test('replacing the Git common directory cannot transfer pending ownership to a new repository',t=>{
 const f=fixture(t);const {env,receipt}=registrar(f);
 const payload={tool_name:'Bash',tool_use_id:'repository-replaced',tool_input:{command:`git -C '${f.repo}' worktree add --orphan .Codex/worktrees/replaced`}};
 assert.deepEqual(call(f,'PreToolUse',payload,env),{});
 renameSync(join(f.repo,'.git'),join(f.repo,'.git-before'));
 assert.equal(spawnSync('git',['init',f.repo],{encoding:'utf8'}).status,0);
 addWorktree(f,'.Codex/worktrees/replaced');
 const result=call(f,'PostToolUse',{...payload,tool_response:'success'},env);
 assert.match(result.hookSpecificOutput.additionalContext,/common-directory identity changed/);
 assert.equal(readdirSync(join(f.data,'worktree-intents')).some(file=>file.endsWith('.reservation.json')),false);
 assert.throws(()=>readFileSync(receipt));
});
test('the target reservation excludes another session and registration errors remain visible',t=>{
 const f=fixture(t);const {env,receipt,script}=registrar(f);
 const first={tool_name:'Bash',tool_use_id:'reserved',tool_input:{command:`git -C '${f.repo}' worktree add --orphan .Codex/worktrees/reserved`}};
 assert.deepEqual(call(f,'PreToolUse',first,env),{});
 const other={...first,session_id:'other-session'};
 const excluded=call(f,'PreToolUse',other,env);
 // Model the host boundary: a competing command would run only if not denied.
 if(excluded.hookSpecificOutput?.permissionDecision!=='deny') addWorktree(f,'.Codex/worktrees/reserved');
 denied(excluded);
 assert.match(excluded.hookSpecificOutput.permissionDecisionReason,/already reserved/);
 addWorktree(f,'.Codex/worktrees/reserved');
 const unpaired=call(f,'PostToolUse',{...other,tool_response:'success'},env);
 assert.match(unpaired.hookSpecificOutput.additionalContext,/no pending intent/);
 assert.throws(()=>readFileSync(receipt));
 rmSync(script);
 const failure=call(f,'PostToolUse',{...first,tool_response:'success'},env);
 assert.match(failure.hookSpecificOutput.additionalContext,/Worktree registration failed/);
 assert.equal(readdirSync(join(f.data,'worktree-intents')).some(file=>file.endsWith('.reservation.json')),false);
 assert.throws(()=>readFileSync(receipt));
});
