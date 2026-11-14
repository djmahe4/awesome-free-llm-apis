import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { applyEdits } from '../src/tools/coding-agents/anchored-edit.js';
import { generateFilePatch } from '../src/tools/coding-agents/generate-file-patch.js';
import type { CodingAgentsInput, CodingAgentsResult } from '../src/tools/coding-agents/types.js';

// #151: a caller that knows the exact change passes it as data, so no prose is parsed and no model runs.

const model = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../src/tools/local-llm-patch.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    localLlmPatch: async () => { model.calls++; return { success: true, patch: '' }; },
}));

const FILE = 'one\ntwo\nthree\n';

describe('applyEdits', () => {
    it('inserts after and before an anchor', () => {
        expect(applyEdits(FILE, [{ file: 'a', anchor: 'one', position: 'after', lines: ['x'] }])).toEqual({ status: 'applied', content: 'one\nx\ntwo\nthree\n' });
        expect(applyEdits(FILE, [{ file: 'a', anchor: 'two', position: 'before', lines: ['x'] }])).toEqual({ status: 'applied', content: 'one\nx\ntwo\nthree\n' });
    });
    it('replaces the anchor line, with any number of lines', () => {
        expect(applyEdits(FILE, [{ file: 'a', anchor: 'two', position: 'replace', lines: ['x', 'y'] }])).toEqual({ status: 'applied', content: 'one\nx\ny\nthree\n' });
    });
    it('matches by prefix when asked', () => {
        expect(applyEdits('alpha beta\n', [{ file: 'a', anchor: 'alpha', anchorIsPrefix: true, position: 'replace', lines: ['x'] }])).toEqual({ status: 'applied', content: 'x\n' });
    });
    it('applies several edits in order and keeps CRLF', () => {
        const r = applyEdits('one\r\ntwo\r\n', [
            { file: 'a', anchor: 'one', position: 'after', lines: ['x'] },
            { file: 'a', anchor: 'x', position: 'after', lines: ['y'] },
        ]);
        expect(r).toEqual({ status: 'applied', content: 'one\r\nx\r\ny\r\ntwo\r\n' });
    });
    it('is already done when run twice', () => {
        const after = { file: 'a', anchor: 'one', position: 'after' as const, lines: ['x'] };
        const replace = { file: 'a', anchor: 'two', position: 'replace' as const, lines: ['y'] };
        const once = applyEdits(FILE, [after, replace]);
        expect(once.status).toBe('applied');
        if (once.status !== 'applied') return;
        expect(applyEdits(once.content, [after, replace])).toEqual({ status: 'already_done' });
    });
    it('changes nothing when any anchor is missing or ambiguous', () => {
        expect(applyEdits(FILE, [{ file: 'a', anchor: 'one', position: 'after', lines: ['x'] }, { file: 'a', anchor: 'nope', position: 'after', lines: ['y'] }])).toEqual({ status: 'no_anchor' });
        expect(applyEdits('a\nb\na\n', [{ file: 'f', anchor: 'a', position: 'after', lines: ['x'] }])).toEqual({ status: 'ambiguous', indexes: [0, 2] });
    });
});

describe('edits in generateFilePatch', () => {
    beforeEach(() => { model.calls = 0; });
    const context = (edits: CodingAgentsInput['edits'], relPath = 'src/a.ts') => {
        const result = { sessionId: 's', goal: 'g', pipelineStage: 'locate', relevantFiles: [], anchors: [], patchPlan: [], patchSummary: '', diagnostics: [], applied: false } as unknown as CodingAgentsResult;
        const ws = path.resolve('some-workspace');
        return {
            input: { goal: 'g', edits } as CodingAgentsInput, result, relPath, fullPath: path.join(ws, relPath), workspaceRoot: ws, sessionId: 's',
            resolvedModel: 'fake-model', originalContent: FILE, activeGoal: 'Make the listed edits.',
            changeFiles: [relPath], runContents: new Map<string, string>(), editedInRun: new Set<string>(),
        };
    };

    it('applies the edits for this file with no model call, and ignores those for other files', async () => {
        const out = await generateFilePatch(context([
            { file: 'src\\a.ts', anchor: 'one', position: 'after', lines: ['x'] },
            { file: 'src/b.ts', anchor: 'one', position: 'after', lines: ['nope'] },
        ]));
        expect(model.calls).toBe(0);
        expect(out).toEqual({ patchedContent: 'one\nx\ntwo\nthree\n', failed: false });
    });
    it('fails with a clear message when an anchor is missing, with no model call', async () => {
        const ctx = context([{ file: 'src/a.ts', anchor: 'nope', position: 'after', lines: ['x'] }]);
        const out = await generateFilePatch(ctx);
        expect(model.calls).toBe(0);
        expect(out.failed).toBe(true);
        expect(JSON.stringify(ctx.result.diagnostics)).toMatch(/anchor/i);
    });
    it('a file with no edits, in a run that has edits, is left alone with no model call', async () => {
        const out = await generateFilePatch(context([{ file: 'src/b.ts', anchor: 'one', position: 'after', lines: ['x'] }]));
        expect(model.calls).toBe(0);
        expect(out).toEqual({ patchedContent: FILE, failed: false });
    });
});
