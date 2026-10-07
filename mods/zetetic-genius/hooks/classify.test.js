import { expect, test } from 'claude-code/testing';
import { classifierSystem, effortForClass, isClassifiable, parseClassification, parseShapes, sameRequest, skillContext, } from './classify';
import { parseGeniusIndex } from './genius';
const TABLE = [
    '# Skill Shape Routing Table — generated, do not edit',
    '',
    '| Shape(s) | Skill | Description |',
    '|---|---|---|',
    '| causal-audit | causal-audit | Correlation walked in; make it prove causation. Use when someone claims "X causes Y" |',
    '| estimation | estimation | Bound it before you build it. Use when a decision is blocked by "we don\'t have data" |',
    '| failure-forensics | failure-forensics | Read the wreckage before rebuilding. |',
].join('\n');
const INDEX = [
    '| **falsifiability-gate** | "is this claim testable?" | [popper](popper.md) | Ask what would refute it |',
    '| **order-of-magnitude-first** | decision blocked by "we don\'t have data" | [fermi](fermi.md) | Bracket before solving |',
].join('\n');
const skills = parseShapes(TABLE);
const genius = parseGeniusIndex(INDEX);
test('the skill table yields one shape per row, header and rule skipped', () => {
    expect(skills.map((s) => s.id)).toEqual(['causal-audit', 'estimation', 'failure-forensics']);
    expect(skills[0]?.description.startsWith('Correlation walked in')).toBe(true);
    expect(parseShapes('')).toEqual([]);
});
test('the system prompt lists the skills, the genius shapes, the JSON contract and the INDEX rule', () => {
    const system = classifierSystem(skills, genius);
    expect(system).toContain('"task_class"');
    expect(system).toContain('"geniuses"');
    expect(system).toContain('- estimation: Bound it before you build it.');
    expect(system).toContain('- falsifiability-gate (popper): "is this claim testable?"');
    expect(system).toContain('do not force a genius agent');
});
test('a strict answer parses; an unknown class, skill or genius pair voids it', () => {
    expect(parseClassification('{"task_class":"routine","shapes":[],"geniuses":[]}', skills, genius)).toEqual({
        taskClass: 'routine',
        shapes: [],
        geniuses: [],
    });
    const fenced = '```json\n{"task_class":"analysis","shapes":["causal-audit","causal-audit"],"geniuses":[]}\n```';
    expect(parseClassification(fenced, skills, genius)?.shapes).toEqual(['causal-audit']);
    const withGenius = '{"task_class":"critical","shapes":[],"geniuses":[{"agent":"popper","shape":"falsifiability-gate"}]}';
    expect(parseClassification(withGenius, skills, genius)?.geniuses).toEqual([{ agent: 'popper', shape: 'falsifiability-gate' }]);
    expect(parseClassification('{"task_class":"hard","shapes":[]}', skills, genius)).toBe(undefined);
    expect(parseClassification('{"task_class":"bugfix","shapes":["popper"]}', skills, genius)).toBe(undefined);
    const wrongPair = '{"task_class":"bugfix","shapes":[],"geniuses":[{"agent":"popper","shape":"order-of-magnitude-first"}]}';
    expect(parseClassification(wrongPair, skills, genius)).toBe(undefined);
    expect(parseClassification('sure, routine', skills, genius)).toBe(undefined);
});
test('two picks at most, genius patterns first', () => {
    const many = '{"task_class":"analysis","shapes":["causal-audit","estimation"],"geniuses":[{"agent":"popper","shape":"falsifiability-gate"},{"agent":"fermi","shape":"order-of-magnitude-first"}]}';
    const c = parseClassification(many, skills, genius);
    expect(c?.geniuses.length).toBe(2);
    expect(c?.shapes).toEqual([]);
    const one = '{"task_class":"analysis","shapes":["causal-audit","estimation"],"geniuses":[{"agent":"popper","shape":"falsifiability-gate"}]}';
    expect(parseClassification(one, skills, genius)?.shapes).toEqual(['causal-audit']);
});
test('each class maps to the effort-calibration table', () => {
    expect(effortForClass('routine')).toBe('low');
    expect(effortForClass('planned')).toBe('low');
    expect(effortForClass('bugfix')).toBe('medium');
    expect(effortForClass('analysis')).toBe('medium');
    expect(effortForClass('critical')).toBe('high');
});
test('slash commands, plugin submits and short continuations are not classified', () => {
    const composer = { kind: 'composer' };
    expect(isClassifiable('/cortex', composer)).toBe(false);
    expect(isClassifiable('yes, go on', composer)).toBe(false);
    expect(isClassifiable('Did the cache change actually cause the latency drop?', { kind: 'plugin' })).toBe(false);
    expect(isClassifiable('Did the cache change actually cause the latency drop?', composer)).toBe(true);
});
test('the skill context names the skills to invoke first, and a request is known by its opening', () => {
    const text = skillContext(['causal-audit', 'estimation']);
    expect(text).toContain('zetetic-team-subagents:causal-audit');
    expect(text).toContain('zetetic-team-subagents:estimation');
    expect(sameRequest('abc', 'abc')).toBe(true);
    expect(sameRequest('a'.repeat(300), 'a'.repeat(200) + 'b'.repeat(100))).toBe(true);
    expect(sameRequest('abc', 'abd')).toBe(false);
});
