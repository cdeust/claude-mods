// The facts cortex-guard enforces and cortex-cockpit reports against, once. Pure, no `$`.
//
// This file exists in both mods (a mod cannot import a file from another mod: the engine refuses it,
// "outside the plugin's folder") and the two copies are byte-identical; scripts/check-shared.sh fails
// when they differ.

// source: ~/.claude/CLAUDE.md rule 2 and Cortex CLAUDE.md: <repo>/.claude/worktrees/<name>/,
// .Codex/worktrees/<name>/ for Codex.
export const WORKTREE_ROOTS = ['/.claude/worktrees/', '/.Codex/worktrees/'] as const

// A Windows path spells its separators `\`; the rules below are written with `/`.
export const withSlashes = (path: string): string => path.replace(/\\/g, '/')

export const isInsideWorktreeRoot = (path: string): boolean => {
  const slashed = withSlashes(path)

  return WORKTREE_ROOTS.some((root) => slashed.includes(root))
}

// source: the python that runs the hygiene script is the first of these that starts: Cortex's own
// hooks resolve `command -v python3 || command -v python`; `py` is the Python launcher for Windows
// (PEP 397), the one name a Windows install always has when python3 is a Store alias that exits 9009.
export const PYTHON_CANDIDATES = ['python3', 'python', 'py'] as const
