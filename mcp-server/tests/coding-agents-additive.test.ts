import { describe, it, expect } from 'vitest';
import { isAdditiveInstruction, applySearchReplaceBlocks } from '../src/tools/coding-agents/patch-gen.js';

// Issue #127: "Change nothing else." at the end of a careful goal contains the word "change", which switched the
// additive guard off. A negated change word is a promise not to change things and must not count as a request.

describe('isAdditiveInstruction ignores negated change words', () => {
    it.each([
        'At the end of the file add one exported function. Change nothing else.',
        'Add a helper to utils.ts; do not change anything else in the file.',
        "Insert a new import line. Don't modify any other code.",
        'Add a function without changing the existing ones.',
        'Create the module. Do not touch, replace or remove anything else.',
        'add one function and leave everything else unchanged',
    ])('additive: %s', (goal) => { expect(isAdditiveInstruction(goal)).toBe(true); });

    it.each([
        'rename x and change y',
        'replace foo with bar',
        'add a parameter and update every caller',
        'fix the bug in parse()',
        'Add logging, then remove the old logger.',
        '',
    ])('not additive: %s', (goal) => { expect(isAdditiveInstruction(goal)).toBe(false); });
});

describe('what the guard protects', () => {
    const FILE = 'export function keep() {\n  return 1;\n}\n\nexport function other() {\n  return 2;\n}\n';
    it('an additive edit that drops its anchor is refused', () => {
        const r = applySearchReplaceBlocks(FILE, [{ search: 'export function keep() {\n  return 1;\n}', replace: 'export function added() {\n  return 3;\n}' }], { additive: true });
        expect(r.appliedCount).toBe(0);
        expect(r.content).toBe(FILE);
    });
    it('an additive edit that keeps its anchor is applied', () => {
        const r = applySearchReplaceBlocks(FILE, [{ search: 'export function keep() {\n  return 1;\n}', replace: 'export function keep() {\n  return 1;\n}\n\nexport function added() {\n  return 3;\n}' }], { additive: true });
        expect(r.appliedCount).toBe(1);
        expect(r.content).toContain('export function added()');
    });
});
