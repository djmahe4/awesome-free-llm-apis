import { describe, it, expect } from 'vitest';
import { editsFromRewrittenExcerpt, applySearchReplaceBlocks } from '../src/tools/coding-agents/patch-gen.js';
import { codeEditCandidates } from '../src/tools/local-llm-patch.js';

// Traced live: asked for SEARCH/REPLACE, qwen2.5-coder:7b mostly returns the whole edited excerpt in a
// ```diff fence (no +/- lines). The edit inside was right (an import and a 4-line guard), but the reply
// was discarded and the run went on to slower strategies. The changed hunks can be recovered by diffing
// the excerpt against the original; SEARCH text then comes from the original, so unchanged code cannot
// be damaged by the model's copy.

const ORIGINAL = [
    "import { a } from './a.js';",
    "import { b } from './b.js';",
    '',
    'export function run(input: string) {',
    '    const id = idOf(input);',
    '',
    '    // validate',
    '    const url = check(input);',
    '    return url;',
    '}',
].join('\n');

const fence = (body: string, lang = 'diff') => '```' + lang + '\n' + body + '\n```';

describe('editsFromRewrittenExcerpt', () => {
    it('turns an edited excerpt into blocks that reproduce exactly the intended change', () => {
        const edited = ORIGINAL
            .replace("import { b } from './b.js';", "import { b } from './b.js';\nimport { c } from './c.js';  // Add this import")
            .replace('    const id = idOf(input);', '    const id = idOf(input);\n    if (!c(input)) return null;  // Insert this line');
        const { blocks } = editsFromRewrittenExcerpt(ORIGINAL, fence(edited));
        expect(blocks.length).toBeGreaterThan(0);
        const r = applySearchReplaceBlocks(ORIGINAL, blocks);
        expect(r.failures).toEqual([]);
        expect(r.content).toBe(ORIGINAL
            .replace("import { b } from './b.js';", "import { b } from './b.js';\nimport { c } from './c.js';")
            .replace('    const id = idOf(input);', '    const id = idOf(input);\n    if (!c(input)) return null;'));
    });

    it('ignores lines the model dropped at the very end or start of the excerpt (copy truncation)', () => {
        const lines = ORIGINAL.split('\n');
        const edited = [...lines.slice(1, -1)].join('\n').replace('    return url;', '    return url ?? null;');
        const { blocks } = editsFromRewrittenExcerpt(ORIGINAL, fence(edited, 'ts'));
        const r = applySearchReplaceBlocks(ORIGINAL, blocks);
        expect(r.content).toBe(ORIGINAL.replace('    return url;', '    return url ?? null;'));
    });

    it('returns nothing for an unchanged copy, prose, or a mangled rewrite', () => {
        expect(editsFromRewrittenExcerpt(ORIGINAL, fence(ORIGINAL)).blocks).toEqual([]);
        expect(editsFromRewrittenExcerpt(ORIGINAL, 'Sure, I can help with that.').blocks).toEqual([]);
        expect(editsFromRewrittenExcerpt(ORIGINAL, fence('function other() {}\nconst z = 1;')).blocks).toEqual([]);
    });

    it('a reply that is already SEARCH/REPLACE is not treated as an excerpt', () => {
        expect(editsFromRewrittenExcerpt(ORIGINAL, '<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE').blocks).toEqual([]);
    });
});

describe('code-edit candidate models', () => {
    it('never includes a vision-language model, even as the last fallback', () => {
        const c = codeEditCandidates(['qwen2.5vl:3b', 'qwen2.5-coder:7b', 'llava:7b', 'BGE-M3:latest', 'nomic-embed-text:latest', 'hf.co/x/Qwythos-9B-GGUF:Q4_K_M']);
        expect(c[0]).toBe('qwen2.5-coder:7b');
        expect(c).not.toContain('qwen2.5vl:3b');
        expect(c).not.toContain('llava:7b');
    });
});
