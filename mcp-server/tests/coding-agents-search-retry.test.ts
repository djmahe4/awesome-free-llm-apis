import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closestLines } from '../src/tools/coding-agents/patch-gen.js';
import { generateFilePatch } from '../src/tools/coding-agents/generate-file-patch.js';
import type { CodingAgentsInput, CodingAgentsResult } from '../src/tools/coding-agents/types.js';

// Issue #115, as it turned out: when a SEARCH block does not match, the retry prompt carries the closest real lines
// of the file (closestLines, bigram similarity of at least 0.55). That works when the model's line is nearly right.
// When it invents a line that is far from the real one ("return subtract(a, b);" for "return a - b;") nothing reaches
// the threshold and the retry says only "not found". Lines that share several identifiers with the SEARCH are a
// useful hint even at low similarity.

const model = vi.hoisted(() => ({ calls: [] as Array<{ instruction: string }>, replies: [] as string[] }));
vi.mock('../src/tools/local-llm-patch.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    localLlmPatch: async (req: { instruction: string }) => {
        model.calls.push({ instruction: req.instruction });
        return { success: true, patch: model.replies.shift() ?? '' };
    },
}));

const FILE = 'export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport function sub(a: number, b: number) {\n  return a - b;\n}\n';
const block = (search: string, replace: string) => `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

describe('closestLines', () => {
    const lines = FILE.split('\n');

    it('still returns a near match first, numbered', () => {
        const hint = closestLines(['import x from "y";', '  for (const m of goal.matchAll(/`([^`]{1,80})`/g)) names.push(m[1]);', 'const z = 1;'], ['for (const m of goal.matchAll(/(`[^`]{1,80}`)/g)) {']);
        expect(hint).toMatch(/^L2: .*names\.push/);
    });
    it('falls back to lines that share several identifiers with a far-off SEARCH', () => {
        const hint = closestLines(lines, ['  return subtract(a, b);']);
        expect(hint).toContain('L6:   return a - b;');
        expect(hint).toContain('L2:   return a + b;');
    });
    it('a near match is never pushed out by the fallback', () => {
        const content = ['const unrelated = alpha + beta;', '  return a - b;', 'return a, b, subtract;'];
        const hint = closestLines(content, ['  return a - b;']);
        expect(hint.split('\n')[0]).toBe('L2:   return a - b;');
    });
    it('says nothing when no line shares two identifiers with the SEARCH', () => {
        expect(closestLines(['alpha beta', 'gamma delta'], ['zzz qqq'])).toBe('');
    });
    it('keeps at most maxLines, in file order', () => {
        const many = Array.from({ length: 10 }, (_, i) => `  return a - b + ${i};`);
        const hint = closestLines(many, ['  return subtract(a, b);'], 3);
        expect(hint.split('\n')).toHaveLength(3);
        expect(hint.split('\n').map(l => Number(l.slice(1, l.indexOf(':'))))).toEqual([...hint.split('\n').map(l => Number(l.slice(1, l.indexOf(':'))))].sort((x, y) => x - y));
    });
});

describe('the SEARCH retry prompt', () => {
    let ws = '';
    beforeAll(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'search-retry-')); fs.writeFileSync(path.join(ws, 'a.ts'), FILE); });
    afterAll(() => fs.rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    beforeEach(() => { model.calls.length = 0; model.replies.length = 0; });

    function context() {
        const result = { sessionId: 's', goal: 'g', pipelineStage: 'locate', relevantFiles: [], anchors: [], patchPlan: [], patchSummary: '', diagnostics: [], applied: false } as unknown as CodingAgentsResult;
        return {
            input: { goal: 'make sub return b - a' } as CodingAgentsInput, result, relPath: 'a.ts', fullPath: path.join(ws, 'a.ts'), workspaceRoot: ws, sessionId: 's',
            resolvedModel: 'fake-model', originalContent: FILE, activeGoal: 'make sub return b - a',
            changeFiles: ['a.ts'], runContents: new Map<string, string>(), editedInRun: new Set<string>(),
        };
    }

    it('after an invented line, the second prompt shows the real line and the first does not', async () => {
        model.replies.push(block('  return subtract(a, b);', '  return b - a;'), block('  return a - b;', '  return b - a;'));
        const out = await generateFilePatch(context());
        expect(model.calls.length).toBeGreaterThanOrEqual(2);
        expect(model.calls[0].instruction).not.toMatch(/L6:/);
        expect(model.calls[1].instruction).toContain('L6:   return a - b;');
        expect(out.patchedContent).toContain('return b - a;');
    });
});
