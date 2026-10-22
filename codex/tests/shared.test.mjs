import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as classify from '../shared/classify.mjs';
import * as fleet from '../shared/fleet.mjs';
import * as genius from '../shared/genius.mjs';
import * as guard from '../shared/guard.mjs';
import * as rules from '../shared/rules.mjs';
import * as wiki from '../shared/wiki.mjs';

const shapes = [{ id: 'bisect', description: 'find the change that broke it' }];
const geniuses = [{ agent: 'euler', shape: 'inversion', trigger: 'reverse constraints' }, { agent: 'gauss', shape: 'sum', trigger: 'sum a series' }];

test('classify: shapes table, effort, classifiability and prompts', () => {
  const table = '| shape | skill | description |\n|---|---|---|\n| xx | bisect | find   the break |\n| yy | Bad | no |';
  assert.deepEqual(classify.parseShapes(table).filter(s => s.id === 'xx'), [{ id: 'xx',description: 'find the break' }]);
  assert.equal(classify.parseShapes('| Upper | s | d |').length, 0);
  assert.equal(classify.effortForClass('bugfix'), 'medium');
  assert.equal(classify.isClassifiable('fix the failing build please', { kind: 'user' }), true);
  assert.equal(classify.isClassifiable('fix the failing build please', { kind: 'plugin' }), false);
  assert.equal(classify.isClassifiable('/help me with something long', { kind: 'user' }), false);
  assert.equal(classify.isClassifiable('yes', { kind: 'user' }), false);
  const system = classify.classifierSystem(shapes, geniuses);
  assert.match(system, /- bisect: find the change/);
  assert.match(system, /- inversion \(euler\): reverse constraints/);
  assert.equal(classify.classifierPrompt('a'.repeat(5000)).length, classify.PROMPT_HEAD_CHARS);
});

test('classify: parseClassification is strict and bounded', () => {
  const ok = classify.parseClassification('```json\n{"task_class":"critical","shapes":["bisect"],"geniuses":[{"agent":"euler","shape":"inversion"}]}\n```', shapes, geniuses);
  assert.deepEqual(ok, { taskClass: 'critical', shapes: ['bisect'], geniuses: [{ agent: 'euler', shape: 'inversion' }] });
  assert.equal(classify.parseClassification('no json', shapes, geniuses), undefined);
  assert.equal(classify.parseClassification('{not json}', shapes, geniuses), undefined);
  assert.equal(classify.parseClassification('{"task_class":"huge"}', shapes, geniuses), undefined);
  assert.equal(classify.parseClassification('{"task_class":"routine","shapes":["nope"]}', shapes, geniuses), undefined);
  assert.equal(classify.parseClassification('{"task_class":"routine","geniuses":[{"agent":"euler","shape":"sum"}]}', shapes, geniuses), undefined);
  assert.equal(classify.parseClassification('{"task_class":"routine","geniuses":[1]}', shapes, geniuses), undefined);
  const capped = classify.parseClassification('{"task_class":"routine","shapes":["bisect","bisect"],"geniuses":[{"agent":"euler","shape":"inversion"},{"agent":"euler","shape":"inversion"},{"agent":"gauss","shape":"sum"}]}', shapes, geniuses);
  assert.equal(capped.geniuses.length, 2);
  assert.deepEqual(capped.shapes, []);
  assert.deepEqual(classify.parseClassification('{"task_class":"bugfix"}', shapes, geniuses), { taskClass: 'bugfix', shapes: [], geniuses: [] });
});

test('classify: classified record, contexts and request binding', () => {
  const c = classify.toClassified({ taskClass: 'analysis', shapes: [], geniuses: [] }, 'text', 10, 25);
  assert.equal(c.effort, 'medium'); assert.equal(c.ms, 15); assert.equal(c.at, 25); assert.equal(c.turnId, null);
  assert.match(classify.advisorContext('critical'), /graded critical/);
  assert.equal(classify.advisorContext('routine'), undefined);
  assert.match(classify.shapeContext(['bisect']), /zetetic-team-subagents:bisect/);
  assert.equal(classify.sameRequest('a'.repeat(300), 'a'.repeat(200) + 'b'), true);
  assert.equal(classify.sameRequest('a', 'b'), false);
});

test('fleet: installed plugins, marketplaces and offered versions', () => {
  const installed = fleet.parseInstalled(JSON.stringify({ plugins: { 'a@m': [{ version: '1.0.0' }], '@bad': [{ version: '1' }], 'b@m': [{}] } }));
  assert.deepEqual(installed, [{ name: 'a', marketplace: 'm', version: '1.0.0' }]);
  assert.throws(() => fleet.parseInstalled('{truncated'), /installed_plugins.json is not valid JSON/);
  assert.throws(() => fleet.parseInstalled('[]'), /no "plugins" object/);
  assert.throws(() => fleet.parseInstalled('{"plugins":{"a@m":1}}'), /not a list/);
  const markets = fleet.parseMarketplaces(JSON.stringify({
    m: { source: { source: 'github', repo: 'Owner/x' }, installLocation: '/m', lastUpdated: 'now' },
    d: { source: { source: 'directory', path: '/d' }, installLocation: '/d' },
    skip: { installLocation: 3 },
  }));
  assert.equal(markets.length, 2);
  assert.equal(markets[0].repo, 'Owner/x'); assert.equal(markets[1].path, '/d'); assert.equal(markets[1].lastUpdated, null);
  assert.throws(() => fleet.parseMarketplaces('[]'), /not an object/);
  assert.deepEqual(fleet.parseOffered('{"plugins":[{"name":"a","version":"2.0.0"},{"name":3},null]}'), { a: '2.0.0' });
  assert.throws(() => fleet.parseOffered('{}'), /no "plugins" list/);
});

test('fleet: versions, ownership and rows', () => {
  assert.equal(fleet.isBehind('1.0.0', '1.0.1'), true);
  assert.equal(fleet.isBehind('1.2', '1.2.0'), false);
  assert.equal(fleet.isBehind('2.0.0', '1.9.9'), false);
  assert.equal(fleet.isBehind('1.0.0', null), false);
  assert.equal(fleet.isBehind('1.0.0', '1.0.0'), false);
  assert.equal(fleet.isBehind('alpha', 'beta'), true);
  const m = { name: 'm', repo: 'Owner/x', path: null, installLocation: '/m', lastUpdated: 'now' };
  assert.equal(fleet.isOwned(m, 'owner'), true);
  assert.equal(fleet.isOwned(m, 'other'), false);
  assert.equal(fleet.isOwned({ ...m, repo: null, path: '/d' }, 'other'), true);
  const rows = fleet.fleetRows(
    [{ name: 'a', marketplace: 'm', version: '1.0.0' }, { name: 'z', marketplace: 'other', version: '1' }],
    [m, { ...m, name: 'empty' }, { ...m, name: 'other', repo: 'Else/y' }],
    { m: { offered: { a: '1.1.0' } }, empty: { error: 'boom' } },
    'owner',
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].plugins[0].isBehind, true); assert.equal(rows[0].manifestError, null);
  const failed = fleet.fleetRows([{ name: 'a', marketplace: 'm', version: '1' }], [m], { m: { error: 'boom' } }, 'owner');
  assert.equal(failed[0].manifestError, 'boom'); assert.equal(failed[0].plugins[0].offered, null);
});

test('fleet: remotes and CI rollups', () => {
  assert.equal(fleet.repoOfRemote('git@github.com:cdeust/claude-mods.git\n'), 'cdeust/claude-mods');
  assert.equal(fleet.repoOfRemote('https://github.com/cdeust/claude-mods'), 'cdeust/claude-mods');
  assert.equal(fleet.repoOfRemote('https://example.com/x/y'), null);
  assert.equal(fleet.ciOf([]), 'none');
  assert.equal(fleet.ciOf([{ conclusion: 'SUCCESS', status: 'COMPLETED' }]), 'success');
  assert.equal(fleet.ciOf([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }]), 'failure');
  assert.equal(fleet.ciOf([{ status: 'IN_PROGRESS' }]), 'pending');
  assert.equal(fleet.ciOf([{ __typename: 'StatusContext', state: 'PENDING' }]), 'pending');
  assert.equal(fleet.ciOf([{ __typename: 'StatusContext', state: 'SUCCESS' }]), 'success');
  assert.equal(fleet.ciOf([{ conclusion: null, status: 'COMPLETED' }]), 'pending');
  assert.equal(fleet.ciOf([{ conclusion: 'SKIPPED' }, { conclusion: 'NEUTRAL' }]), 'none');
  assert.equal(fleet.ciOf([{ conclusion: 'MYSTERY' }]), 'pending');
});

test('fleet: gh readings, argv and labels', () => {
  const prs = fleet.parsePrList(JSON.stringify([{ number: 1, title: 't', isDraft: true, updatedAt: 'u', url: 'x', statusCheckRollup: [{ conclusion: 'SUCCESS' }] }, { number: 2, title: 'u' }, { title: 'no number' }]));
  assert.equal(prs.length, 2); assert.equal(prs[0].ci, 'success'); assert.equal(prs[1].ci, 'none'); assert.equal(prs[1].isDraft, false);
  assert.throws(() => fleet.parsePrList('{}'), /not a list/);
  const issues = fleet.parseIssues(JSON.stringify([{ number: 3, title: 'i', labels: [{ name: 'bug' }, {}], createdAt: 'c', comments: [1, 2], url: 'u' }, { number: 4, title: 'j' }, {}]));
  assert.equal(issues.length, 2); assert.deepEqual(issues[0].labels, ['bug']); assert.equal(issues[0].comments, 2); assert.deepEqual(issues[1].labels, []);
  assert.throws(() => fleet.parseIssues('{}'), /not a list/);
  assert.equal(fleet.issueKind(['Enhancement']), 'feature');
  assert.equal(fleet.issueKind(['bug']), 'defect');
  assert.ok(fleet.prListArgv('o/r').includes(String(fleet.PR_LIMIT + 1)));
  assert.ok(fleet.issueListArgv('o/r').includes(String(fleet.ISSUE_LIMIT)));
  assert.ok(fleet.prCountArgv('o/r').includes('owner=o'));
  assert.deepEqual(fleet.remoteArgv('/p'), ['git', '-C', '/p', 'remote', 'get-url', 'origin']);
  assert.equal(fleet.parsePrCount('{"data":{"repository":{"pullRequests":{"totalCount":12}}}}'), 12);
  assert.throws(() => fleet.parsePrCount('{}'), /no pullRequests.totalCount/);
  const base = { error: null, prs: [1, 2], prTotal: 2, prTotalError: null };
  assert.equal(fleet.prsLabel({ ...base, error: 'x' }), 'PRs: no reading');
  assert.match(fleet.prsLabel({ ...base, prTotal: null, prTotalError: 'why' }), /total not read \(why\)/);
  assert.match(fleet.prsLabel({ ...base, prTotal: null }), /no reason given/);
  assert.equal(fleet.prsLabel({ ...base, prTotal: 15 }), '2 of 15 open PRs');
  assert.equal(fleet.prsLabel({ ...base, prs: [1], prTotal: 1 }), '1 open PR');
});

test('fleet: prompts and lessons', () => {
  assert.match(fleet.reviewPrompt('o/r', { number: 7, title: 't', ci: 'success' }), /Review PR #7 of o\/r/);
  assert.match(fleet.takeIssuePrompt('o/r', { number: 1, title: 't', labels: ['feature'], comments: 0 }), /feature request/);
  assert.match(fleet.takeIssuePrompt('o/r', { number: 1, title: 't', labels: [], comments: 1 }), /no label, 1 comment\)/);
  assert.match(fleet.takeIssuePrompt('o/r', { number: 1, title: 't', labels: ['bug'], comments: 2 }), /bug, 2 comments/);
  assert.equal(fleet.lessonCell(null, 'x'), 'x: no reading');
  assert.equal(fleet.lessonCell(3, 'x'), '3 x');
  const l = { refusals: 1, classifierErrors: null, stuckEscalations: 0, offloads: 2 };
  assert.match(fleet.lessonsLine(l), /classifier errors: no reading/);
  assert.match(fleet.draftIssuePrompt(['a/b', 'c/d'], l), /Candidate repositories: a\/b, c\/d/);
});

test('genius: installed path, index rows and pattern sections', () => {
  const rec = JSON.stringify({ plugins: { [genius.GENIUS_PLUGIN]: [{ installPath: '/p' }] } });
  assert.equal(genius.installPathOf(rec, genius.GENIUS_PLUGIN), '/p');
  assert.equal(genius.installPathOf('{}', genius.GENIUS_PLUGIN), undefined);
  assert.throws(() => genius.installPathOf('{x', 'p'), /not valid JSON/);
  const rows = genius.parseGeniusIndex('| **inversion** | reverse | [euler](euler.md) | flip |\nnoise');
  assert.deepEqual(rows, [{ shape: 'inversion', trigger: 'reverse', agent: 'euler', keyMove: 'flip' }]);
  const file = '---\nname: euler\neffort: high\n---\n<identity>\nFirst para.\n\nSecond.\n</identity>\n<workflow>\nstep\n</workflow>\n<output-format>\nout\n</output-format>';
  assert.equal(genius.sectionOf(file, 'workflow'), 'step');
  assert.equal(genius.sectionOf(file, 'missing'), undefined);
  assert.equal(genius.identityOpening(file), 'First para.');
  assert.equal(genius.identityOpening('none'), '');
  assert.equal(genius.patternEffort(file), 'high');
  assert.equal(genius.patternEffort('no frontmatter'), undefined);
  const ctx = genius.geniusContext('euler', file, rows, '/p/euler.md');
  assert.match(ctx, /Shape inversion: reverse. Key move: flip/);
  assert.match(ctx, /Workflow:\nstep/);
  assert.match(genius.geniusContext('euler', 'x', [], '/f'), /no workflow section/);
});

test('guard: wiki paths, shell writes and worktree placement', () => {
  assert.equal(guard.judgePath('docs/adr/ADR-1060-x.md').rule, guard.WIKI_RULE);
  assert.equal(guard.judgePath('a\\wiki\\adr\\x.md').rule, guard.WIKI_RULE);
  assert.equal(guard.judgePath('wiki/adr/x.md').allow, false);
  assert.equal(guard.judgePath('src/a.md').allow, true);
  assert.equal(guard.judgeShellWiki('ls wiki/adr/x.md').allow, true);
  assert.equal(guard.judgeShellWiki('echo hi > "wiki/specs/x.md"').allow, false);
  assert.equal(guard.judgeShellWiki('echo hi > out.txt').allow, true);
  assert.equal(guard.worktreeAddPath('git -C /r -c a=b worktree add -b br /r/.claude/worktrees/x main'), '/r/.claude/worktrees/x');
  assert.equal(guard.worktreeAddPath('git status'), undefined);
  assert.equal(guard.worktreeAddPath('git worktree add -f'), undefined);
  assert.equal(guard.judgeShellWorktree('git worktree add /tmp/x').rule, guard.WORKTREE_RULE);
  assert.equal(guard.judgeShellWorktree('git worktree add /r/.claude/worktrees/x').allow, true);
  assert.equal(guard.judgeShell('cp a wiki/adr/x.md').rule, guard.WIKI_RULE);
  assert.equal(guard.judgeShell('git worktree add /tmp/x').rule, guard.WORKTREE_RULE);
  assert.equal(guard.judgeCall('Write', { file_path: 'wiki/adr/x.md' }).allow, false);
  assert.equal(guard.judgeCall('NotebookEdit', { notebook_path: 'wiki/adr/x.md' }).allow, false);
  assert.equal(guard.judgeCall('Bash', { command: 'git worktree add /tmp/x' }).allow, false);
  assert.equal(guard.judgeCall('Read', {}).allow, true);
});

test('rules and wiki: worktree roots, tikz conversion and targets', () => {
  assert.equal(rules.withSlashes('a\\b'), 'a/b');
  assert.equal(rules.isInsideWorktreeRoot('C:\\r\\.claude\\worktrees\\x'), true);
  assert.equal(rules.isInsideWorktreeRoot('/tmp/x'), false);
  const md = 'a\n```tikz\n\\draw (0,0);\n```\nb';
  assert.equal(wiki.diagramCount(md), 1);
  assert.match(wiki.toPandocSource(md), /```\{=latex\}\n\\begin\{tikzpicture\}/);
  const argv = wiki.pandocArgv('in.md', 'out.pdf');
  assert.equal(argv[0], 'pandoc'); assert.deepEqual(argv.slice(-3), ['in.md', '-o', 'out.pdf']);
  assert.equal(wiki.wikiTarget('  ').ok, false);
  assert.equal(wiki.wikiTarget('a/../wiki/x.md').ok, false);
  assert.equal(wiki.wikiTarget('docs/x.md').ok, false);
  assert.deepEqual(wiki.wikiTarget('wiki/x.md'), { ok: true, path: 'wiki/x.md' });
});
