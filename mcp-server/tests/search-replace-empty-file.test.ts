import { describe, it, expect } from 'vitest';
import { applySearchReplaceBlocks } from '../src/tools/coding-agents/patch-gen.js';

// Issue #116: asked to create a file, a small model answered with a complete implementation in the REPLACE half and
// a made-up SEARCH ("// No existing code to search for"). There is nothing in an empty file to find, so the SEARCH
// cannot match and the complete, correct REPLACE was thrown away.

const IMPL = 'export const a = 1;\nexport function b() {\n  return a;\n}\n';

describe('SEARCH/REPLACE against a file with nothing in it', () => {
    it('an invented SEARCH against an empty file still applies the REPLACE body', () => {
        const r = applySearchReplaceBlocks('', [{ search: '// No existing code to search for', replace: IMPL }]);
        expect(r.failures).toEqual([]);
        expect(r.appliedCount).toBe(1);
        expect(r.content.trim()).toBe(IMPL.trim());
    });
    it('a file that holds only whitespace counts as empty', () => {
        const r = applySearchReplaceBlocks('\n  \n', [{ search: 'anything', replace: IMPL }]);
        expect(r.failures).toEqual([]);
        expect(r.content.trim()).toBe(IMPL.trim());
    });
    it('an empty SEARCH against an empty file works as before', () => {
        const r = applySearchReplaceBlocks('', [{ search: '', replace: IMPL }]);
        expect(r.appliedCount).toBe(1);
        expect(r.content.trim()).toBe(IMPL.trim());
    });
    it('a file that has content is never replaced by an unmatched SEARCH', () => {
        const original = 'export const keep = 1;\n';
        const r = applySearchReplaceBlocks(original, [{ search: '// No existing code to search for', replace: IMPL }]);
        expect(r.appliedCount).toBe(0);
        expect(r.failures.length).toBe(1);
        expect(r.content).toBe(original);
    });
    it('a later block can still match what an earlier block just wrote into an empty file', () => {
        const r = applySearchReplaceBlocks('', [
            { search: '// nothing here', replace: 'export const a = 1;\nexport const b = 2;\n' },
            { search: 'export const b = 2;', replace: 'export const b = 3;' },
        ]);
        expect(r.appliedCount).toBe(2);
        expect(r.content).toContain('export const b = 3;');
        expect(r.content).not.toContain('export const b = 2;');
    });
});
