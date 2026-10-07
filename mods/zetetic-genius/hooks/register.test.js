import { expect, mock, test } from 'claude-code/testing';
// Wiring: prompt.submit grades the request and, enforced, attaches the pattern; turn.start binds.
const TABLE = [
    '| Shape(s) | Skill | Description |',
    '|---|---|---|',
    '| estimation | estimation | Bound it before you build it. |',
].join('\n');
const INDEX = '| **falsifiability-gate** | "is this claim testable?" | [popper](popper.md) | Ask what would refute it |';
const INSTALLED = JSON.stringify({
    plugins: { 'zetetic-team-subagents@zetetic-marketplace': [{ installPath: '/p' }] },
});
const POPPER = [
    '---',
    'effort: medium',
    '---',
    '<identity>',
    'You are the Popper reasoning pattern: ask what would refute it.',
    '</identity>',
    '<workflow>',
    '1. Demarcation pass.',
    '</workflow>',
    '<output-format>',
    '### Falsifiability Analysis',
    '</output-format>',
].join('\n');
const stubs = (on, answer, seen) => {
    mock.clock(on, { now: 1000000 });
    on('session.start', () => ({ cwd: '/r' }));
    on('env.get', () => ({ value: '/home/t' }));
    on('fs.read', ($, e) => {
        const path = String(e.path ?? '');
        if (path.endsWith('skill-routing-table.md'))
            return { value: TABLE };
        if (path.endsWith('installed_plugins.json'))
            return { value: INSTALLED };
        if (path.endsWith('INDEX.md'))
            return { value: INDEX };
        if (path.endsWith('popper.md'))
            return { value: POPPER };
        return { deny: `no such file in the test: ${path}` };
    });
    on('model.complete', () => {
        seen.completions += 1;
        return {
            value: {
                isAnswered: true,
                text: answer,
                usage: { input_tokens: 400, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            },
        };
    });
    on('prompt.submit', ($, e) => {
        seen.context = e.context;
        return { text: e.text };
    });
    on('turn.start', ($, e) => ({ turnId: e.turnId }));
};
const PROMPT = { wait: false, origin: { kind: 'composer' } };
const GRADED = '{"task_class":"critical","shapes":[],"geniuses":[{"agent":"popper","shape":"falsifiability-gate"}]}';
test('observe: the request is graded once and the prompt goes through untouched', async ($, on) => {
    const seen = { completions: 0 };
    stubs(on, GRADED, seen);
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' });
    await $.prompt.submit({ ...PROMPT, text: 'Is the claim that the cache caused the speedup even testable?' });
    expect(seen.completions).toBe(1);
    expect(seen.context).toBe(undefined);
});
test('enforce: the popper workflow rides beside the prompt', { options: { mode: 'enforce' } }, async ($, on) => {
    const seen = { completions: 0 };
    stubs(on, GRADED, seen);
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' });
    await $.prompt.submit({ ...PROMPT, text: 'Is the claim that the cache caused the speedup even testable?' });
    expect(seen.context?.length).toBe(1);
    expect(seen.context?.[0]).toContain('apply the popper reasoning pattern');
    expect(seen.context?.[0]).toContain('1. Demarcation pass.');
    expect(seen.context?.[0]).toContain('/p/agents/genius/popper.md');
});
test('a slash command and an off-contract answer leave the prompt alone', { options: { mode: 'enforce' } }, async ($, on) => {
    const seen = { completions: 0 };
    stubs(on, 'critical, I think', seen);
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/r' });
    await $.prompt.submit({ ...PROMPT, text: '/cortex' });
    expect(seen.completions).toBe(0);
    await $.prompt.submit({ ...PROMPT, text: 'Explain why the consolidation job runs twice a night' });
    expect(seen.completions).toBe(1);
    expect(seen.context).toBe(undefined);
});
