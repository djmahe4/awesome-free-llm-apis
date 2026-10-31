import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applySearchReplaceBlocks, isEndOfFileInstruction } from '../src/tools/coding-agents/patch-gen.js';
import { generateFilePatch } from '../src/tools/coding-agents/generate-file-patch.js';
import type { CodingAgentsInput, CodingAgentsResult } from '../src/tools/coding-agents/types.js';

// Issue #125: allowAppend existed but nothing turned it on, so adding code at the end of a file needed an invented
// anchor. A goal that says "at the end of the file" now allows an empty SEARCH, and says so in the instruction.

const model = vi.hoisted(() => ({ calls: [] as Array<{ instruction: string }>, replies: [] as string[] }));
vi.mock('../src/tools/local-llm-patch.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    localLlmPatch: async (req: { instruction: string }) => {
        model.calls.push({ instruction: req.instruction });
        return { success: true, patch: model.replies.shift() ?? '' };
    },
}));

const FILE = 'export function one() {\n  return 1;\n}\n\nexport function two() {\n  return 2;\n}\n';
const NEW_FN = 'export function three() {\n  return 3;\n}';
const emptySearch = `<<<<<<< SEARCH\n\n=======\n${NEW_FN}\n>>>>>>> REPLACE`;

describe('isEndOfFileInstruction', () => {
    it.each([
        'At the very end of src/a.ts add one exported function',
        'add a helper at the end of the file',
        'Append the function to utils.ts',
        'put it to the end of src/a.ts',
    ])('recognises: %s', (goal) => { expect(isEndOfFileInstruction(goal)).toBe(true); });

    it.each([
        'Fix the end condition of the loop in parse()',
        'Rename the variable at the start of the function',
        'make sub return b - a',
        '',
    ])('does not recognise: %s', (goal) => { expect(isEndOfFileInstruction(goal)).toBe(false); });
});

describe('an empty SEARCH against a file that has content', () => {
    it('appends only when allowAppend is on', () => {
        const on = applySearchReplaceBlocks(FILE, [{ search: '', replace: NEW_FN }], { allowAppend: true });
        expect(on.appliedCount).toBe(1);
        expect(on.content.startsWith(FILE.trimEnd())).toBe(true);
        expect(on.content).toContain('export function three()');
        const off = applySearchReplaceBlocks(FILE, [{ search: '', replace: NEW_FN }]);
        expect(off.appliedCount).toBe(0);
        expect(off.content).toBe(FILE);
    });
});

describe('through generateFilePatch', () => {
    let ws = '';
    beforeAll(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'append-')); fs.writeFileSync(path.join(ws, 'a.ts'), FILE); });
    afterAll(() => fs.rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    beforeEach(() => { model.calls.length = 0; model.replies.length = 0; });

    function context(goal: string) {
        const result = { sessionId: 's', goal: 'g', pipelineStage: 'locate', relevantFiles: [], anchors: [], patchPlan: [], patchSummary: '', diagnostics: [], applied: false } as unknown as CodingAgentsResult;
        return {
            input: { goal } as CodingAgentsInput, result, relPath: 'a.ts', fullPath: path.join(ws, 'a.ts'), workspaceRoot: ws, sessionId: 's',
            resolvedModel: 'fake-model', originalContent: FILE, activeGoal: goal,
            changeFiles: ['a.ts'], runContents: new Map<string, string>(), editedInRun: new Set<string>(),
        };
    }

    it('an end-of-file goal tells the model to leave SEARCH empty, and an empty-SEARCH reply appends', async () => {
        model.replies.push(emptySearch);
        const out = await generateFilePatch(context('At the very end of a.ts add one exported function three that returns 3'));
        expect(model.calls[0].instruction).toMatch(/leave the SEARCH part empty/i);
        expect(out.patchedContent.startsWith(FILE.trimEnd())).toBe(true);
        expect(out.patchedContent).toContain('export function three()');
    });

    it('another goal gets no such instruction and an empty-SEARCH reply is not applied', async () => {
        model.replies.push(emptySearch, emptySearch);
        const out = await generateFilePatch(context('make two return 3 instead of 2'));
        expect(model.calls[0].instruction).not.toMatch(/leave the SEARCH part empty/i);
        expect(out.patchedContent).not.toContain('export function three()');
    });
});

describe('a placeholder comment as SEARCH in an end-of-file edit', () => {
    // qwen2.5-coder:7b never leaves SEARCH empty; it writes a comment that is not in the file.
    const placeholder = (search: string) => [{ search, replace: NEW_FN }];

    it.each([
        '// No existing code to search for',
        '// Add new function at the end of the file',
        '# nothing to match here',
        '/* append below */',
    ])('is read as an append when allowAppend is on: %s', (search) => {
        const r = applySearchReplaceBlocks(FILE, placeholder(search), { allowAppend: true });
        expect(r.failures).toEqual([]);
        expect(r.appliedCount).toBe(1);
        expect(r.content.startsWith(FILE.trimEnd())).toBe(true);
        expect(r.content).toContain('export function three()');
    });
    it('is still refused when allowAppend is off', () => {
        const r = applySearchReplaceBlocks(FILE, placeholder('// No existing code to search for'), {});
        expect(r.appliedCount).toBe(0);
        expect(r.content).toBe(FILE);
    });
    it('a comment that IS in the file is an ordinary anchor, not an append', () => {
        const withComment = '// the helpers\nexport function one() {\n  return 1;\n}\n';
        const r = applySearchReplaceBlocks(withComment, [{ search: '// the helpers', replace: '// the helpers\n// more' }], { allowAppend: true });
        expect(r.content).toBe('// the helpers\n// more\nexport function one() {\n  return 1;\n}\n');
    });
    it('a SEARCH with code in it that is missing is still refused with allowAppend on', () => {
        const r = applySearchReplaceBlocks(FILE, placeholder('return subtract(a, b);'), { allowAppend: true });
        expect(r.appliedCount).toBe(0);
        expect(r.failures.length).toBe(1);
        expect(r.content).toBe(FILE);
    });
    it('a SEARCH that mixes a comment and code is not a placeholder', () => {
        const r = applySearchReplaceBlocks(FILE, placeholder('// note\nreturn subtract(a, b);'), { allowAppend: true });
        expect(r.appliedCount).toBe(0);
    });
});
