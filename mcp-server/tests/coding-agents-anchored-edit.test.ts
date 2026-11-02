import { describe, it, expect } from 'vitest';
import { parseAnchoredGoal, findAnchor, applyAnchored, anchorWindow } from '../src/tools/coding-agents/anchored-edit.js';

// #148: a goal that quotes an anchor line and supplies the lines to add is applied by a script, or the model is
// shown a small window around the anchor.

const FILE = [
    'import a from "a";',
    'export const one = 1;',
    '',
    '    maxRepairAttempts: { type: "number", description: "retries" },',
    '    maxDurationMs: { type: "number" },',
    '',
    'export const two = 2;',
].join('\n');

const AFTER_GOAL = 'Directly after the line that starts with `    maxRepairAttempts: {` add these two lines with the same indent: `    requireRed: { type: "boolean" },` and `    hasPostConditions: { type: "boolean" },`. Change nothing else.';

describe('parseAnchoredGoal', () => {
    it('reads the position, the anchor and the lines to add', () => {
        expect(parseAnchoredGoal(AFTER_GOAL)).toEqual({
            position: 'after', anchor: '    maxRepairAttempts: {', anchorIsPrefix: true,
            lines: ['    requireRed: { type: "boolean" },', '    hasPostConditions: { type: "boolean" },'],
        });
    });
    it('reads above and before as the same position', () => {
        expect(parseAnchoredGoal('Directly above the line `export const two = 2;` add the line `export const three = 3;`.')?.position).toBe('before');
        expect(parseAnchoredGoal('Directly before the line `export const two = 2;` add the line `export const three = 3;`.')?.position).toBe('before');
    });
    it('a whole-line anchor is not a prefix', () => {
        expect(parseAnchoredGoal('Directly after the line `export const one = 1;` add the line `export const three = 3;`.')?.anchorIsPrefix).toBe(false);
    });
    it('is undefined without an anchor, without lines to add, or when the addition is negated', () => {
        expect(parseAnchoredGoal('Add the line `export const three = 3;` somewhere.')).toBeUndefined();
        expect(parseAnchoredGoal('Directly after the line `export const one = 1;` make it faster.')).toBeUndefined();
        expect(parseAnchoredGoal('Do not add the line `export const three = 3;` directly after the line `export const one = 1;`.')).toBeUndefined();
    });
});

describe('a goal with more than one edit is not an anchored edit', () => {
    it('two anchor clauses', () => {
        expect(parseAnchoredGoal('Directly after the line `export const one = 1;` add the line `export const a = 1;`. Directly after the line `export const two = 2;` add the line `export const b = 2;`.')).toBeUndefined();
    });
    it('two add requests with one anchor', () => {
        expect(parseAnchoredGoal('Directly after the line `export const one = 1;` add the line `export const a = 1;`, and add the line `export const b = 2;` at the top of the file.')).toBeUndefined();
    });
    it('an Edit 1 / Edit 2 or Step list', () => {
        expect(parseAnchoredGoal('EDIT 1: directly after the line `export const one = 1;` add the line `export const a = 1;`. EDIT 2: change `two` to `three`.')).toBeUndefined();
        expect(parseAnchoredGoal('Step 1: directly after the line `export const one = 1;` add the line `export const a = 1;`. Step 2: rename two.')).toBeUndefined();
    });
    it('applyAnchored leaves such a goal to the model', () => {
        expect(applyAnchored(FILE, 'EDIT 1: directly after the line `export const one = 1;` add the line `export const a = 1;`. EDIT 2: rename two.')).toEqual({ status: 'not_applicable' });
    });
});

describe('findAnchor', () => {
    it('finds one match, by whole line or by prefix', () => {
        expect(findAnchor(FILE, 'export const one = 1;', false)).toEqual({ status: 'one', index: 1 });
        expect(findAnchor(FILE, '    maxRepairAttempts: {', true)).toEqual({ status: 'one', index: 3 });
    });
    it('reports several matches with their line numbers', () => {
        expect(findAnchor('x\nfoo\nbar\nfoo', 'foo', false)).toEqual({ status: 'many', indexes: [1, 3] });
    });
    it('reports no match', () => {
        expect(findAnchor(FILE, 'nothing like this', false)).toEqual({ status: 'none' });
    });
    it('compares lines without trailing whitespace or carriage returns', () => {
        expect(findAnchor('a  \r\nb\r\n', 'a', false)).toEqual({ status: 'one', index: 0 });
    });
});

describe('applyAnchored', () => {
    it('inserts the lines after the anchor and touches nothing else', () => {
        const r = applyAnchored(FILE, AFTER_GOAL);
        expect(r.status).toBe('applied');
        if (r.status !== 'applied') return;
        const lines = r.content.split('\n');
        expect(lines[3]).toContain('maxRepairAttempts');
        expect(lines[4]).toBe('    requireRed: { type: "boolean" },');
        expect(lines[5]).toBe('    hasPostConditions: { type: "boolean" },');
        expect(lines).toHaveLength(FILE.split('\n').length + 2);
        expect(r.content.replace('    requireRed: { type: "boolean" },\n    hasPostConditions: { type: "boolean" },\n', '')).toBe(FILE);
    });
    it('inserts before the anchor', () => {
        const r = applyAnchored(FILE, 'Directly above the line `export const two = 2;` add the line `export const three = 3;`.');
        expect(r.status === 'applied' && r.content.split('\n')[6]).toBe('export const three = 3;');
    });
    it('keeps the file line ending', () => {
        const crlf = FILE.replace(/\n/g, '\r\n');
        const r = applyAnchored(crlf, AFTER_GOAL);
        expect(r.status === 'applied' && r.content.includes('\r\n    requireRed')).toBe(true);
        expect(r.status === 'applied' && /[^\r]\n/.test(r.content)).toBe(false);
    });
    it('does not add a line that is already there', () => {
        const once = applyAnchored(FILE, AFTER_GOAL);
        expect(once.status).toBe('applied');
        if (once.status !== 'applied') return;
        expect(applyAnchored(once.content, AFTER_GOAL)).toEqual({ status: 'already_done' });
    });
    it('asks for a choice when the anchor matches several lines, and stops when it matches none', () => {
        const many = applyAnchored('foo\nbar\nfoo', 'Directly after the line `foo` add the line `export const three = 3;`.');
        expect(many).toEqual({ status: 'ambiguous', indexes: [0, 2] });
        expect(applyAnchored(FILE, 'Directly after the line `no such line here` add the line `export const three = 3;`.')).toEqual({ status: 'no_anchor' });
    });
    it('is not applicable to a goal without an anchor', () => {
        expect(applyAnchored(FILE, 'Make it faster.')).toEqual({ status: 'not_applicable' });
    });
});

describe('anchorWindow', () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    it('shows a window of the asked size around the anchor line', () => {
        const w = anchorWindow(long, 100, 20);
        expect(w.text.split('\n')).toHaveLength(20);
        expect(w.text).toContain('line 100');
        expect(w.startIdx).toBe(90);
        expect(w.endIdx).toBe(110);
    });
    it('stays inside the file at both ends', () => {
        expect(anchorWindow(long, 2, 20).startIdx).toBe(0);
        expect(anchorWindow(long, 198, 20).endIdx).toBe(200);
    });
});
