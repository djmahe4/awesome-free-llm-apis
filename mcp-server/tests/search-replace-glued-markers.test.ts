import { describe, it, expect } from 'vitest';
import { parseSearchReplaceBlocksDetailed } from '../src/tools/coding-agents/patch-gen.js';

// Issue #123: a cloud model answered with a correct function but wrote the separator on the same line as the last
// SEARCH line ("}=======") and the closing marker on the same line as the last REPLACE line ("}>>>>>>> REPLACE").
// The parser wants markers on lines of their own, found no block and threw the answer away.

const GLUED = '<<<<<<< SEARCH\n}=======\n}export function nearestLines(a: string): string[] {\n  return [a];\n}>>>>>>> REPLACE';
const PROPER = '<<<<<<< SEARCH\n}\n=======\n}export function nearestLines(a: string): string[] {\n  return [a];\n}\n>>>>>>> REPLACE';

describe('markers glued to the end of a line', () => {
    it('a glued separator and a glued closing marker still give one block', () => {
        const { blocks, incomplete } = parseSearchReplaceBlocksDetailed(GLUED);
        expect(incomplete).toBe(0);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].search).toBe('}');
        expect(blocks[0].replace).toBe('}export function nearestLines(a: string): string[] {\n  return [a];\n}');
    });
    it('gives the same block as the version with the markers on their own lines', () => {
        expect(parseSearchReplaceBlocksDetailed(GLUED).blocks).toEqual(parseSearchReplaceBlocksDetailed(PROPER).blocks);
    });
    it('a glued bare closing marker (">>>>>>>" without REPLACE) works too', () => {
        const { blocks } = parseSearchReplaceBlocksDetailed('<<<<<<< SEARCH\nold\n=======\nnew}>>>>>>>');
        expect(blocks).toEqual([{ search: 'old', replace: 'new}' }]);
    });
    it('markers on their own lines behave exactly as before', () => {
        const { blocks } = parseSearchReplaceBlocksDetailed('<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> REPLACE');
        expect(blocks).toEqual([{ search: 'const a = 1;', replace: 'const a = 2;' }]);
    });
    it('equals signs in the middle of a line are not a separator', () => {
        const { blocks } = parseSearchReplaceBlocksDetailed('<<<<<<< SEARCH\nif (a ======= b) {\n=======\nif (a === b) {\n>>>>>>> REPLACE');
        expect(blocks).toEqual([{ search: 'if (a ======= b) {', replace: 'if (a === b) {' }]);
    });
    it('two blocks, the first with a glued separator, both come out', () => {
        const text = '<<<<<<< SEARCH\nfoo()=======\nbar()\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nbaz\n=======\nqux\n>>>>>>> REPLACE';
        const { blocks } = parseSearchReplaceBlocksDetailed(text);
        expect(blocks).toEqual([{ search: 'foo()', replace: 'bar()' }, { search: 'baz', replace: 'qux' }]);
    });
});
