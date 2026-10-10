import { realpathSync, lstatSync } from 'node:fs';
import { resolve, dirname, basename, relative, isAbsolute, parse, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { judgePath } from '../shared/guard.mjs';
import { shellTokens, shellWritePaths } from './shell.mjs';

// New files inherit the physical identity of their nearest existing ancestor.
export function physicalPath(path, cwd) {
  let current = isAbsolute(path) ? parse(path).root : realpathSync(cwd);
  const components = (isAbsolute(path) ? path.slice(current.length) : path).split(sep);
  for (const component of components) {
    if (!component || component === '.') continue;
    if (component === '..') { current = dirname(current); continue; }
    const next = join(current, component);
    try {
      // lstat distinguishes an absent file from a dangling link. The latter must
      // fail closed because its target identity cannot be established.
      lstatSync(next);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      current = next; continue;
    }
    current = realpathSync(next);
  }
  return current;
}
function checkPath(path, cwd, directories = false) {
  if (typeof path !== 'string' || !path) throw new Error('Missing file path');
  for (const value of [resolve(cwd, path), physicalPath(path, cwd)]) {
    const verdict = judgePath(value);
    if (!verdict.allow) return verdict;
    if (directories && (/(^|\/)wiki(?:\/(?:adr|specs|lessons))?$/.test(value) || /(^|\/)docs\/adr$/.test(value)))
      return { allow: false, rule: 'wiki-write-only', reason: 'This directory contains canonical wiki pages or ADR mirrors; use Cortex wiki tools.' };
  }
  return { allow: true };
}

// Literal shell words only: this is deliberately not a shell evaluator.
// git(1), git-worktree(1) define the argv grammar. Compound/dynamic worktree
// operations cannot establish ownership here and must be split by the caller.
const gitValues = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
function gitOptions(words, at) {
  let i = at + 1, gitCwd, relativeDirectory = false;
  while (i < words.length && words[i].startsWith('-')) {
    const flag = words[i++];
    if (flag === '--') break;
    if (flag === '-C' && !words[i]) throw new Error('git -C requires a directory');
    if (flag === '-C' || (flag.startsWith('-C') && flag.length > 2)) {
      const directory = flag === '-C' ? words[i++] : flag.slice(2);
      relativeDirectory ||= !isAbsolute(directory);
      gitCwd = directory;
    } else if (gitValues.has(flag)) i++;
  }
  return { i, gitCwd, relativeDirectory };
}
function worktreePath(words, start) {
  for (let i = start; i < words.length; i++) {
    const arg = words[i];
    if (arg === '--') return words[++i];
    if (['-b', '-B', '--reason'].includes(arg)) { i++; continue; }
    if (!arg.startsWith('-')) return arg;
  }
}
export function worktreeRequest(command) {
  if (!command.includes('worktree') || !command.includes('add')) return [];
  const tokens = shellTokens(command);
  const words = tokens.map(token => token.value);
  const dynamic = tokens.some(token => token.dynamic);
  const requests = [];
  for (let at = 0; at < words.length; at++) {
    if (basename(words[at]) !== 'git') continue;
    const { i, gitCwd, relativeDirectory } = gitOptions(words, at);
    if (words[i] !== 'worktree' || words[i + 1] !== 'add') continue;
    // Native Bash envelopes omit exec_command.workdir (Codex rust-v0.162.1
    // core/src/tools/handlers/unified_exec/exec_command.rs:514-524). Session cwd
    // cannot establish the executed repository, even for absolute target paths.
    if (!gitCwd || relativeDirectory) throw new Error('Worktree operations require explicit absolute git -C <repository>.');
    if (dynamic || at !== 0 || tokens.some(token => token.kind !== 'word'))
      throw new Error('Use one literal git worktree add command; expansion and compound commands cannot establish ownership.');
    if (words.slice(at + 1, i).some(w => w.startsWith('-c') || w.startsWith('--config-env') || w.startsWith('--git-dir') || w.startsWith('--work-tree')))
      throw new Error('Use git -C without repository/config overrides for worktree operations.');
    const path = worktreePath(words, i + 2);
    if (!path) throw new Error('git worktree add requires a literal path');
    const result = spawnSync('git', ['-C', gitCwd, 'worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Cannot resolve git repository: ${result.stderr?.trim() || result.error?.message}`);
    const first = result.stdout.split('\0')[0];
    if (!first.startsWith('worktree ')) throw new Error('Git did not return its main worktree');
    requests.push({ repo: realpathSync(first.slice(9)), path: physicalPath(path, gitCwd) });
  }
  return requests;
}
function inside(path, root) {
  const part = relative(root, path);
  return part !== '' && part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') && !isAbsolute(part);
}
export function guard(input) {
  const name = input.tool_name, args = input.tool_input;
  if (typeof name !== 'string' || !args || typeof args !== 'object') throw new Error('Tool hook requires tool_name and tool_input');
  const patchTool = name === 'apply_patch' || name.endsWith('__apply_patch');
  const shellTool = ['Bash', 'exec_command', 'shell_command'].includes(name) || name.endsWith('__exec_command');
  if (!patchTool && !shellTool && !['Edit', 'Write', 'NotebookEdit'].includes(name)) return { allow: true };
  const cwd = args.workdir ?? args.cwd ?? input.cwd;
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('Tool hook requires an absolute cwd');
  if (['Edit', 'Write', 'NotebookEdit'].includes(name)) return checkPath(args.file_path ?? args.notebook_path, cwd);
  if (patchTool) {
    const patch = args.command ?? args.patch ?? args.input;
    if (typeof patch !== 'string') throw new Error('apply_patch requires a patch string');
    const paths = [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(m => m[1]);
    if (!paths.length) throw new Error('Patch has no recognizable file headers');
    for (const path of paths) { const verdict = checkPath(path, cwd); if (!verdict.allow) return verdict; }
    return { allow: true };
  }
  if (shellTool) {
    const command = args.command ?? args.cmd;
    if (typeof command !== 'string') throw new Error('Shell tool requires a command string');
    // Best effort over actual file operands; quoted script data is not a path.
    for (const path of shellWritePaths(shellTokens(command))) {
      const verdict = checkPath(path, cwd, true); if (!verdict.allow) return verdict;
    }
    for (const request of worktreeRequest(command)) {
      if (!['.claude', '.Codex'].some(host => inside(request.path, resolve(request.repo, host, 'worktrees'))))
        return { allow: false, rule: 'worktree-inside-repo', reason: 'Worktrees must live below the real repository .claude/worktrees/ or .Codex/worktrees/ directory.' };
    }
  }
  return { allow: true };
}
