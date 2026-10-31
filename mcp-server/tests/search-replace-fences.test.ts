import { describe, it, expect } from 'vitest';
import { parseSearchReplaceBlocksDetailed, applySearchReplaceBlocks } from '../src/tools/coding-agents/patch-gen.js';

// Issue #130: a cloud model wrapped the code of a SEARCH/REPLACE reply in markdown fences. The fence lines are not
// source code; applied literally they made the file unparseable and the edit was rolled back, five times in a row.

const TICKS = '```';
const reply = (search: string, replace: string) => `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;
const parse = (s: string, r: string) => parseSearchReplaceBlocksDetailed(reply(s, r)).blocks;

describe('fences around the code of a reply', () => {
    it('a fence-only SEARCH is empty and the fenced REPLACE loses its fence lines', () => {
        const blocks = parse(`${TICKS}\n${TICKS}`, `${TICKS}typescript\nexport const a = 1;\nexport const b = 2;\n${TICKS}`);
        expect(blocks).toEqual([{ search: '', replace: 'export const a = 1;\nexport const b = 2;' }]);
    });
    it('a normal SEARCH keeps its text and a fenced REPLACE loses the fence lines', () => {
        const blocks = parse('const a = 1;', `${TICKS}ts\nconst a = 2;\n${TICKS}`);
        expect(blocks).toEqual([{ search: 'const a = 1;', replace: 'const a = 2;' }]);
    });
    it('a fenced SEARCH with real text inside, and a fenced REPLACE, are a markdown edit and stay as written', () => {
        const s = `${TICKS}ts\nold();\n${TICKS}`;
        const r = `${TICKS}ts\nnew();\n${TICKS}`;
        expect(parse(s, r)).toEqual([{ search: s, replace: r }]);
    });
    it('a fence in the middle of a REPLACE is left alone', () => {
        const r = `/**\n * Example:\n * ${TICKS}\n * f();\n * ${TICKS}\n */\nexport function f() {}`;
        expect(parse('// placeholder', r)).toEqual([{ search: '// placeholder', replace: r }]);
    });
    it('a REPLACE with only an opening fence is not cut', () => {
        expect(parse('x', `${TICKS}ts\ncode();`)).toEqual([{ search: 'x', replace: `${TICKS}ts\ncode();` }]);
    });
    it('the whole reply from the trace applies to a new file as the plain code', () => {
        const blocks = parse(`${TICKS}\n${TICKS}`, `${TICKS}typescript\nexport function sanitizeText(input: string): string {\n  return input;\n}\n${TICKS}`);
        const r = applySearchReplaceBlocks('', blocks);
        expect(r.failures).toEqual([]);
        expect(r.content.trim()).toBe('export function sanitizeText(input: string): string {\n  return input;\n}');
    });
    it('plain replies behave exactly as before', () => {
        expect(parse('a', 'b')).toEqual([{ search: 'a', replace: 'b' }]);
        expect(parse('', 'b')).toEqual([{ search: '', replace: 'b' }]);
    });
});
