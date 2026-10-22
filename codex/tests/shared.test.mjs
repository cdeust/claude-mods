import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as classify from '../shared/classify.mjs';
import * as fleet from '../shared/fleet.mjs';
import * as genius from '../shared/genius.mjs';
import * as guard from '../shared/guard.mjs';
import * as rules from '../shared/rules.mjs';
import * as wiki from '../shared/wiki.mjs';

const shapes = [{ id: 'first-principles', description: 'start from the facts' }, { id: 'inversion', description: 'reverse it' }];
const geniuses = [{ agent: 'feynman', shape: 'explain', trigger: 'explain simply' }, { agent: 'popper', shape: 'falsify', trigger: 'test a claim' }];

test('classify: shapes table rows become shapes, header and separator do not', () => {
  const table = '| Shape | Skill | Description |\n|---|---|---|\n| inversion | skill | reverse   it | x |\n| Bad | skill | y | z |\nnot a row';
  assert.deepEqual(classify.parseShapes(table), [{ id: 'inversion', description: 'reverse it' }]);
});

test('classify: effort follows the class and only longer, non-command text from a person is classifiable', () => {
  assert.equal(classify.effortForClass('routine'), 'low');
  assert.equal(classify.effortForClass('bugfix'), 'medium');
  assert.equal(classify.effortForClass('critical'), 'high');
  const long = 'please refactor the parser module';
  assert.equal(classify.isClassifiable(long, { kind: 'user' }), true);
  assert.equal(classify.isClassifiable(long, { kind: 'plugin' }), false);
  assert.equal(classify.isClassifiable('/clear this out please now', { kind: 'user' }), false);
  assert.equal(classify.isClassifiable('go on', { kind: 'user' }), false);
});

test('classify: the system prompt lists skills and genius shapes; the prompt is cut to its head', () => {
  const system = classify.classifierSystem(shapes, geniuses);
  assert.match(system, /- inversion: reverse it/);
  assert.match(system, /- falsify \(popper\): test a claim/);
  assert.equal(classify.classifierPrompt('x'.repeat(classify.PROMPT_HEAD_CHARS + 50)).length, classify.PROMPT_HEAD_CHARS);
});

test('classify: an answer is read strictly', () => {
  const ok = classify.parseClassification('```json\n{"task_class":"bugfix","shapes":["inversion"],"geniuses":[]}\n```', shapes, geniuses);
  assert.deepEqual(ok, { taskClass: 'bugfix', shapes: ['inversion'], geniuses: [] });
  assert.equal(classify.parseClassification('no json here', shapes, geniuses), undefined);
  assert.equal(classify.parseClassification('{not json}', shapes, geniuses), undefined);
  assert.equal(classify.parseClassification('{"task_class":"huge"}', shapes, geniuses), undefined);
  assert.equal(classify.parseClassification('{"task_class":5}', shapes, geniuses), undefined);
  assert.equal(classify.parseClassification('{"task_class":"routine","shapes":["unknown"]}', shapes, geniuses), undefined);
  assert.equal(classify.parseClassification('{"task_class":"routine","geniuses":[{"agent":"nobody","shape":"x"}]}', shapes, geniuses), undefined);
  assert.equal(classify.parseClassification('{"task_class":"routine","geniuses":[null]}', shapes, geniuses), undefined);
  assert.equal(classify.parseClassification('{"task_class":"routine","geniuses":[{"agent":1,"shape":"x"}]}', shapes, geniuses), undefined);
});

test('classify: duplicates fold and the picks are capped', () => {
  const answer = JSON.stringify({
    task_class: 'analysis',
    shapes: ['inversion', 'inversion', 'first-principles'],
    geniuses: [{ agent: 'feynman', shape: 'explain' }, { agent: 'feynman', shape: 'explain' }],
  });
  const c = classify.parseClassification(answer, shapes, geniuses);
  assert.equal(c.geniuses.length, 1);
  assert.equal(c.shapes.length, classify.MAX_PICKS - 1);
  const both = classify.parseClassification(JSON.stringify({ task_class: 'analysis', shapes: ['inversion'], geniuses: geniuses.map(({ agent, shape }) => ({ agent, shape })) }), shapes, geniuses);
  assert.equal(both.geniuses.length, classify.MAX_PICKS);
  assert.deepEqual(both.shapes, []);
});

test('classify: a classification becomes a graded turn; the advisor and shape contexts are worded', () => {
  const graded = classify.toClassified({ taskClass: 'critical', shapes: [], geniuses: [] }, 'text', 100, 160);
  assert.equal(graded.effort, 'high');
  assert.equal(graded.ms, 60);
  assert.equal(graded.at, 160);
  assert.equal(graded.turnId, null);
  assert.match(classify.advisorContext('critical'), /graded critical/);
  assert.equal(classify.advisorContext('routine'), undefined);
  assert.match(classify.shapeContext(['inversion']), /zetetic-team-subagents:inversion/);
  assert.equal(classify.sameRequest('a'.repeat(300), 'a'.repeat(200) + 'b'.repeat(100)), true);
  assert.equal(classify.sameRequest('a', 'b'), false);
});

test('fleet: installed plugins are read, a malformed record is an error naming its source', () => {
  const json = JSON.stringify({ plugins: { 'a@m': [{ version: '1.0.0' }], bad: [{ version: '1' }], 'b@m': [{}] } });
  assert.deepEqual(fleet.parseInstalled(json), [{ name: 'a', marketplace: 'm', version: '1.0.0' }]);
  assert.throws(() => fleet.parseInstalled('{'), /installed_plugins.json is not valid JSON/);
  assert.throws(() => fleet.parseInstalled('[]'), /no "plugins" object/);
  assert.throws(() => fleet.parseInstalled('{"plugins":{"a@m":1}}'), /not a list/);
});

test('fleet: marketplaces and their offered versions', () => {
  const json = JSON.stringify({
    gh: { source: { source: 'github', repo: 'Owner/Repo' }, installLocation: '/x', lastUpdated: '2026-10-01' },
    dir: { source: { source: 'directory', path: '/work' }, installLocation: '/y' },
    none: { installLocation: '/z' },
    broken: { source: {} },
    odd: 3,
  });
  const ms = fleet.parseMarketplaces(json);
  assert.deepEqual(ms.map((m) => m.name), ['gh', 'dir', 'none']);
  assert.equal(ms[0].repo, 'Owner/Repo');
  assert.equal(ms[1].path, '/work');
  assert.equal(ms[1].lastUpdated, null);
  assert.throws(() => fleet.parseMarketplaces('[]'), /not an object/);
  assert.deepEqual(fleet.parseOffered('{"plugins":[{"name":"a","version":"2"},{"name":"b"},null]}'), { a: '2' });
  assert.throws(() => fleet.parseOffered('{}'), /no "plugins" list/);
});

test('fleet: versions compare field by field, text otherwise', () => {
  assert.equal(fleet.isBehind('1.0.0', null), false);
  assert.equal(fleet.isBehind('1.0.0', '1.0.0'), false);
  assert.equal(fleet.isBehind('1.2.0', '1.10.0'), true);
  assert.equal(fleet.isBehind('2.0', '1.9.9'), false);
  assert.equal(fleet.isBehind('1.0', '1.0.0'), false);
  assert.equal(fleet.isBehind('a', 'b'), true);
});

test('fleet: rows keep the owner marketplaces with something installed', () => {
  const installed = [{ name: 'a', marketplace: 'gh', version: '1.0.0' }, { name: 'b', marketplace: 'other', version: '1' }, { name: 'c', marketplace: 'dir', version: '1' }];
  const marketplaces = [
    { name: 'gh', repo: 'Owner/Repo', path: null, installLocation: '/x', lastUpdated: 't' },
    { name: 'other', repo: 'else/Repo', path: null, installLocation: '/o', lastUpdated: null },
    { name: 'dir', repo: null, path: '/work', installLocation: '/d', lastUpdated: null },
    { name: 'empty', repo: 'owner/empty', path: null, installLocation: '/e', lastUpdated: null },
  ];
  const rows = fleet.fleetRows(installed, marketplaces, { gh: { offered: { a: '1.1.0' } }, dir: { error: 'unreadable' } }, 'owner');
  assert.deepEqual(rows.map((r) => r.marketplace), ['gh', 'dir']);
  assert.equal(rows[0].plugins[0].isBehind, true);
  assert.equal(rows[0].manifestError, null);
  assert.equal(rows[1].manifestError, 'unreadable');
  assert.equal(rows[1].plugins[0].offered, null);
  assert.equal(fleet.isOwned(marketplaces[1], 'owner'), false);
});

test('fleet: remote urls name their repository', () => {
  assert.equal(fleet.repoOfRemote('git@github.com:owner/name.git\n'), 'owner/name');
  assert.equal(fleet.repoOfRemote('https://github.com/owner/name'), 'owner/name');
  assert.equal(fleet.repoOfRemote('https://example.com/owner/name'), null);
});

test('fleet: checks roll up to one state', () => {
  const run = (conclusion, status = 'COMPLETED') => ({ __typename: 'CheckRun', status, conclusion });
  assert.equal(fleet.ciOf([]), 'none');
  assert.equal(fleet.ciOf([run('SUCCESS')]), 'success');
  assert.equal(fleet.ciOf([run('SUCCESS'), run('FAILURE')]), 'failure');
  assert.equal(fleet.ciOf([run(null, 'IN_PROGRESS')]), 'pending');
  assert.equal(fleet.ciOf([run(undefined)]), 'pending');
  assert.equal(fleet.ciOf([run('SKIPPED')]), 'none');
  assert.equal(fleet.ciOf([run('SOMETHING_NEW')]), 'pending');
  assert.equal(fleet.ciOf([{ __typename: 'StatusContext', state: 'SUCCESS' }]), 'success');
  assert.equal(fleet.ciOf([{ __typename: 'StatusContext', state: 'PENDING' }]), 'pending');
  assert.equal(fleet.ciOf([{ __typename: 'StatusContext', state: 'ERROR' }]), 'failure');
});

test('fleet: gh output is parsed, a malformed answer is an error', () => {
  const prs = fleet.parsePrList(JSON.stringify([{ number: 1, title: 't', isDraft: true, updatedAt: 'u', url: 'x', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }, { number: 2, title: 'bare' }, { title: 'no number' }]));
  assert.equal(prs.length, 2);
  assert.equal(prs[0].ci, 'success');
  assert.equal(prs[0].isDraft, true);
  assert.equal(prs[1].ci, 'none');
  assert.throws(() => fleet.parsePrList('{}'), /not a list/);
  assert.throws(() => fleet.parsePrList('nope'), /gh pr list output is not valid JSON/);
  const issues = fleet.parseIssues(JSON.stringify([{ number: 3, title: 'i', labels: [{ name: 'bug' }, {}], comments: [1, 2], createdAt: 'c', url: 'u' }, { number: 4, title: 'bare' }, {}]));
  assert.deepEqual(issues.map((i) => [i.number, i.labels, i.comments]), [[3, ['bug'], 2], [4, [], 0]]);
  assert.throws(() => fleet.parseIssues('{}'), /not a list/);
  assert.equal(fleet.parsePrCount('{"data":{"repository":{"pullRequests":{"totalCount":12}}}}'), 12);
  assert.throws(() => fleet.parsePrCount('{}'), /no pullRequests.totalCount/);
});

test('fleet: the read-only calls and the prompts a button sends', () => {
  assert.equal(fleet.prListArgv('o/r').at(-1), String(fleet.PR_LIMIT + 1));
  assert.ok(fleet.prCountArgv('o/r').includes('owner=o'));
  assert.ok(fleet.issueListArgv('o/r').includes(String(fleet.ISSUE_LIMIT)));
  assert.deepEqual(fleet.remoteArgv('/w'), ['git', '-C', '/w', 'remote', 'get-url', 'origin']);
  assert.equal(fleet.issueKind(['Enhancement']), 'feature');
  assert.equal(fleet.issueKind(['bug']), 'defect');
  assert.match(fleet.reviewPrompt('o/r', { number: 5, title: 'T', ci: 'success' }), /Review PR #5 of o\/r/);
  assert.match(fleet.takeIssuePrompt('o/r', { number: 6, title: 'T', labels: ['proposal'], comments: 0 }), /feature request/);
  assert.match(fleet.takeIssuePrompt('o/r', { number: 6, title: 'T', labels: [], comments: 1 }), /no label, 1 comment\)/);
  assert.match(fleet.takeIssuePrompt('o/r', { number: 6, title: 'T', labels: ['bug', 'p1'], comments: 2 }), /bug, p1, 2 comments/);
});

test('fleet: counts are never zero when they could not be read', () => {
  assert.equal(fleet.prsLabel({ error: 'x', prs: [], prTotal: null, prTotalError: null }), 'PRs: no reading');
  assert.match(fleet.prsLabel({ error: null, prs: [1], prTotal: null, prTotalError: null }), /1 open PR shown, total not read \(no reason given\)/);
  assert.equal(fleet.prsLabel({ error: null, prs: [1, 2], prTotal: 15, prTotalError: null }), '2 of 15 open PRs');
  assert.equal(fleet.prsLabel({ error: null, prs: [1, 2], prTotal: 2, prTotalError: null }), '2 open PRs');
  assert.equal(fleet.lessonCell(null, 'guard refusals'), 'guard refusals: no reading');
  const l = { refusals: 3, classifierErrors: null, stuckEscalations: 0, offloads: 1 };
  assert.equal(fleet.lessonsLine(l), '3 guard refusals · classifier errors: no reading · 0 stuck escalations · 1 results offloaded');
  assert.match(fleet.draftIssuePrompt(['o/a', 'o/b'], l), /Candidate repositories: o\/a, o\/b\./);
});

test('genius: the installed path is read, a record that is not JSON is an error', () => {
  const json = JSON.stringify({ plugins: { [genius.GENIUS_PLUGIN]: [{ installPath: '/p' }], empty: [{ installPath: '' }] } });
  assert.equal(genius.installPathOf(json, genius.GENIUS_PLUGIN), '/p');
  assert.equal(genius.installPathOf(json, 'empty'), undefined);
  assert.equal(genius.installPathOf(json, 'missing'), undefined);
  assert.throws(() => genius.installPathOf('{', 'x'), /not valid JSON/);
});

test('genius: INDEX rows, sections and the context beside the prompt', () => {
  const rows = genius.parseGeniusIndex('| **inversion** | reverse constraints | [invert](invert.md) | reason backwards |\nprose');
  assert.deepEqual(rows, [{ shape: 'inversion', trigger: 'reverse constraints', agent: 'invert', keyMove: 'reason backwards' }]);
  const file = '---\neffort: high\n---\n<identity>\nFirst paragraph.\n\nSecond.\n</identity>\n<workflow>\nstep one\n</workflow>';
  assert.equal(genius.sectionOf(file, 'workflow'), 'step one');
  assert.equal(genius.sectionOf(file, 'missing'), undefined);
  assert.equal(genius.identityOpening(file), 'First paragraph.');
  assert.equal(genius.identityOpening('none'), '');
  assert.equal(genius.patternEffort(file), 'high');
  assert.equal(genius.patternEffort('no frontmatter'), undefined);
  const context = genius.geniusContext('invert', file, rows, '/p/invert.md');
  assert.match(context, /apply the invert reasoning pattern/);
  assert.match(context, /Shape inversion: reverse constraints\. Key move: reason backwards/);
  assert.match(context, /step one/);
  assert.match(context, /\(no output-format section\)/);
  assert.match(genius.geniusContext('invert', '', [], '/p'), /\(no workflow section\)/);
});

test('guard: wiki pages are written only through the wiki tool', () => {
  assert.equal(guard.judgePath('src/a.ts').allow, true);
  const mirror = guard.judgePath('docs/adr/ADR-1060-x.md');
  assert.equal(mirror.allow, false);
  assert.equal(mirror.rule, guard.WIKI_RULE);
  assert.equal(guard.judgePath('repo\\wiki\\adr\\a.md').allow, false);
  assert.equal(guard.judgePath('repo/wiki/adr/a.md').allow, false);
  assert.equal(guard.judgeShellWiki('cat wiki/adr/a.md').allow, true);
  assert.equal(guard.judgeShellWiki('echo hi > "wiki/specs/a.md"').allow, false);
  assert.equal(guard.judgeShellWiki('rm docs/adr/ADR-1-a.md').allow, false);
  assert.equal(guard.judgeShellWiki('echo hi > notes.txt').allow, true);
});

test('guard: a worktree lives inside the repo', () => {
  assert.equal(guard.worktreeAddPath('ls'), undefined);
  assert.equal(guard.worktreeAddPath('git status'), undefined);
  assert.equal(guard.worktreeAddPath('git worktree add'), undefined);
  assert.equal(guard.worktreeAddPath('git worktree add -b feature ../x main'), '../x');
  assert.equal(guard.worktreeAddPath('git -C /repo -c a=b worktree add --detach /tmp/w'), '/tmp/w');
  assert.equal(guard.worktreeAddPath('git --git-dir=/g worktree add /tmp/w'), '/tmp/w');
  assert.equal(guard.worktreeAddPath('git worktree add -b only'), undefined);
  assert.equal(guard.judgeShellWorktree('git worktree add /repo/.claude/worktrees/a').allow, true);
  const outside = guard.judgeShellWorktree('git worktree add ../x');
  assert.equal(outside.allow, false);
  assert.equal(outside.rule, guard.WORKTREE_RULE);
  assert.equal(guard.judgeShell('git worktree add ../x').allow, false);
  assert.equal(guard.judgeShell('git status').allow, true);
  assert.equal(guard.judgeShell('echo x > wiki/adr/a.md').rule, guard.WIKI_RULE);
});

test('guard: every tool call is judged by what it names', () => {
  assert.equal(guard.judgeCall('Edit', { file_path: 'wiki/adr/a.md' }).allow, false);
  assert.equal(guard.judgeCall('Write', { file_path: 'src/a.ts' }).allow, true);
  assert.equal(guard.judgeCall('NotebookEdit', { notebook_path: 'wiki/specs/a.md' }).allow, false);
  assert.equal(guard.judgeCall('Bash', { command: 'git worktree add ../x' }).allow, false);
  assert.equal(guard.judgeCall('Bash', {}).allow, true);
  assert.equal(guard.judgeCall('Read', { file_path: 'wiki/adr/a.md' }).allow, true);
});

test('rules: paths are slashed and worktree roots recognised', () => {
  assert.equal(rules.withSlashes('a\\b'), 'a/b');
  assert.equal(rules.isInsideWorktreeRoot('C:\\repo\\.claude\\worktrees\\a'), true);
  assert.equal(rules.isInsideWorktreeRoot('/repo/.Codex/worktrees/a'), true);
  assert.equal(rules.isInsideWorktreeRoot('/repo/other'), false);
  assert.deepEqual(rules.PYTHON_CANDIDATES, ['python3', 'python', 'py']);
});

test('wiki: tikz fences become raw latex jobs for pandoc', () => {
  const md = 'text\n```tikz\n\\node {a};\n```\nmore';
  assert.equal(wiki.diagramCount(md), 1);
  assert.equal(wiki.diagramCount('plain'), 0);
  assert.match(wiki.toPandocSource(md), /```\{=latex\}\n\\begin\{tikzpicture\}\n\\node \{a\};\n\\end\{tikzpicture\}\n```/);
  const argv = wiki.pandocArgv('in.md', 'out.pdf');
  assert.equal(argv[0], 'pandoc');
  assert.equal(argv.at(-1), 'out.pdf');
  assert.ok(argv.includes('in.md'));
});

test('wiki: only wiki markdown pages are targets', () => {
  assert.deepEqual(wiki.wikiTarget(' wiki/a.md '), { ok: true, path: 'wiki/a.md' });
  assert.match(wiki.wikiTarget('').reason, /usage/);
  assert.match(wiki.wikiTarget('wiki/../a.md').reason, /no "\.\."/);
  assert.match(wiki.wikiTarget('docs/a.md').reason, /not a wiki/);
});
