// Generated from mods/cortex-guard/hooks/guard.ts; run npm run build:codex.
import { isInsideWorktreeRoot, withSlashes } from './rules.mjs';
const MIRROR = /(^|\/)docs\/adr\/ADR-\d+[^/]*\.md$/;
const CANONICAL = /(^|\/)wiki\/(adr|specs|lessons)\/.+\.md$/;
const ALLOW = {
    allow: true
};
export const WIKI_RULE = 'wiki-write-only';
export const WORKTREE_RULE = 'worktree-inside-repo';
const refuseWiki = (path, why)=>({
        allow: false,
        rule: WIKI_RULE,
        reason: `${path}: ${why} Use the Cortex wiki_write tool (wiki_adr for a decision); wiki_reindex regenerates the mirror.`
    });
export const judgePath = (path)=>{
    const slashed = withSlashes(path);
    if (MIRROR.test(slashed)) return refuseWiki(path, 'a generated read-only mirror.');
    if (CANONICAL.test(slashed)) return refuseWiki(path, 'a canonical wiki page, written only through the wiki tool.');
    return ALLOW;
};
const WRITES_FILES = /(^|[\s;&|(])(sed\s+-i|tee|cp|mv|rm|truncate|dd|perl\s+-pi)\b|>>?\s*\S/;
const tokensOf = (command)=>command.split(/\s+/).map((t)=>t.replace(/^['"]|['"]$/g, ''));
export const judgeShellWiki = (command)=>{
    if (!WRITES_FILES.test(command)) return ALLOW;
    for (const path of tokensOf(command)){
        const verdict = judgePath(path);
        if (!verdict.allow) return verdict;
    }
    return ALLOW;
};
const GIT_VALUED_OPTIONS = new Set([
    '-C',
    '-c',
    '--git-dir',
    '--work-tree',
    '--namespace',
    '--exec-path'
]);
const gitSubcommandIndex = (t, at)=>{
    let i = at + 1;
    while(i < t.length && (t[i] ?? '').startsWith('-')){
        i += GIT_VALUED_OPTIONS.has(t[i] ?? '') ? 2 : 1;
    }
    return i;
};
export const worktreeAddPath = (command)=>{
    const t = tokensOf(command);
    let at = -1;
    for(let i = 0; i < t.length && at < 0; i++){
        if (t[i] !== 'git') continue;
        const sub = gitSubcommandIndex(t, i);
        if (t[sub] === 'worktree' && t[sub + 1] === 'add') at = sub;
    }
    if (at < 0) return undefined;
    const args = t.slice(at + 2);
    for(let i = 0; i < args.length; i++){
        const a = args[i] ?? '';
        if (a === '-b' || a === '-B' || a === '--orphan') {
            i++;
            continue;
        }
        if (a.startsWith('-')) continue;
        return a;
    }
    return undefined;
};
export const judgeShellWorktree = (command)=>{
    const path = worktreeAddPath(command);
    if (path === undefined || isInsideWorktreeRoot(path)) return ALLOW;
    return {
        allow: false,
        rule: WORKTREE_RULE,
        reason: `git worktree add ${path}: a worktree lives at <repo>/.claude/worktrees/<name>/ (.Codex/worktrees/ for Codex), never outside the repo.`
    };
};
export const judgeShell = (command)=>{
    const wiki = judgeShellWiki(command);
    return wiki.allow ? judgeShellWorktree(command) : wiki;
};
export const judgeCall = (tool, input)=>{
    if ((tool === 'Edit' || tool === 'Write') && input.file_path !== undefined) return judgePath(input.file_path);
    if (tool === 'NotebookEdit' && input.notebook_path !== undefined) return judgePath(input.notebook_path);
    if (tool === 'Bash' && input.command !== undefined) return judgeShell(input.command);
    return ALLOW;
};
