// Generated from mods/cortex-guard/hooks/rules.ts; run npm run build:codex.
export const WORKTREE_ROOTS = [
    '/.claude/worktrees/',
    '/.Codex/worktrees/'
];
export const withSlashes = (path)=>path.replace(/\\/g, '/');
export const isInsideWorktreeRoot = (path)=>{
    const slashed = withSlashes(path);
    return WORKTREE_ROOTS.some((root)=>slashed.includes(root));
};
export const PYTHON_CANDIDATES = [
    'python3',
    'python',
    'py'
];
