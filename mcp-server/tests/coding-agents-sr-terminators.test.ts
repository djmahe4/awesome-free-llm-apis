import { describe, it, expect } from 'vitest';
import { parseSearchReplaceBlocksDetailed } from '../src/tools/coding-agents/patch-gen.js';
import { rejectReply } from '../src/tools/local-llm-patch.js';

// Traced live: qwen2.5-coder:7b wrote a correct block but closed it with a second "=======" instead of
// ">>>>>>> REPLACE". The reply was rejected as "no SEARCH/REPLACE block" and the run fell back to two
// other models and then a 126 s whole-file regeneration, every attempt.
const SECOND_DIVIDER = [
    '<<<<<<< SEARCH',
    'const sessionId = sessionIdOf(input);',
    '=======',
    'const sessionId = sessionIdOf(input);',
    'const unsupported = findUnsupportedOptions(input);',
    '=======',
    '',
].join('\n');

const reply = (content: string) => ({ content, promptTokens: 10, numCtx: 4096, promptTruncated: false, outputTruncated: false } as any);

describe('SEARCH/REPLACE terminators small models actually write', () => {
    it('a second ======= closes the block', () => {
        const { blocks, incomplete } = parseSearchReplaceBlocksDetailed(SECOND_DIVIDER);
        expect(incomplete).toBe(0);
        expect(blocks).toEqual([{ search: 'const sessionId = sessionIdOf(input);', replace: 'const sessionId = sessionIdOf(input);\nconst unsupported = findUnsupportedOptions(input);' }]);
        expect(rejectReply(reply(SECOND_DIVIDER), true)).toBeNull();
    });

    it('a bare >>>>>>> closes the block', () => {
        const text = '<<<<<<< SEARCH\na\n=======\nb\n>>>>>>>\n';
        expect(parseSearchReplaceBlocksDetailed(text).blocks).toEqual([{ search: 'a', replace: 'b' }]);
        expect(rejectReply(reply(text), true)).toBeNull();
    });

    it('two blocks closed with ======= are both parsed', () => {
        const text = '<<<<<<< SEARCH\na\n=======\nA\n=======\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n';
        expect(parseSearchReplaceBlocksDetailed(text).blocks).toEqual([{ search: 'a', replace: 'A' }, { search: 'b', replace: 'B' }]);
    });

    it('a reply cut off inside REPLACE is still incomplete, and prose is still rejected', () => {
        expect(parseSearchReplaceBlocksDetailed('<<<<<<< SEARCH\na\n=======\nb').incomplete).toBe(1);
        expect(rejectReply(reply('Sure! Here is how you would do it.'), true)).toMatch(/no SEARCH\/REPLACE block/);
    });
});
