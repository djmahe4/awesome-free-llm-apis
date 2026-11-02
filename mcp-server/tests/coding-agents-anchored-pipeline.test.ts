import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { generateFilePatch } from '../src/tools/coding-agents/generate-file-patch.js';
import type { CodingAgentsInput, CodingAgentsResult } from '../src/tools/coding-agents/types.js';

// #148: a goal that quotes an anchor and supplies the lines to add is applied by a script, with no model call.

const model = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../src/tools/local-llm-patch.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    localLlmPatch: async () => { model.calls++; return { success: true, patch: '' }; },
}));

const FILE = 'export const one = 1;\nexport const two = 2;\nexport const two = 2;\nexport const four = 4;\n';
const ws = path.resolve('some-workspace');

function context(goal: string, content = FILE) {
    const result = { sessionId: 's', goal: 'g', pipelineStage: 'locate', relevantFiles: [], anchors: [], patchPlan: [], patchSummary: '', diagnostics: [], applied: false } as unknown as CodingAgentsResult;
    return {
        input: { goal } as CodingAgentsInput, result, relPath: 'a.ts', fullPath: path.join(ws, 'a.ts'), workspaceRoot: ws, sessionId: 's',
        resolvedModel: 'fake-model', originalContent: content, activeGoal: goal,
        changeFiles: ['a.ts'], runContents: new Map<string, string>(), editedInRun: new Set<string>(),
    };
}

describe('anchored goals in generateFilePatch', () => {
    beforeEach(() => { model.calls = 0; });

    it('applies the supplied lines next to the anchor without calling a model', async () => {
        const out = await generateFilePatch(context('Directly after the line `export const one = 1;` add the line `export const half = 0.5;`. Change nothing else.'));
        expect(model.calls).toBe(0);
        expect(out.failed).toBe(false);
        expect(out.patchedContent).toBe('export const one = 1;\nexport const half = 0.5;\nexport const two = 2;\nexport const two = 2;\nexport const four = 4;\n');
    });
    it('leaves the file as it was when the lines are already there', async () => {
        const out = await generateFilePatch(context('Directly after the line `export const four = 4;` add the line `export const one = 1;`.'));
        expect(model.calls).toBe(0);
        expect(out.failed).toBe(false);
        expect(out.patchedContent).toBe(FILE);
    });
    it('fails with a clear message when the anchor matches several lines', async () => {
        const ctx = context('Directly after the line `export const two = 2;` add the line `export const half = 0.5;`.');
        const out = await generateFilePatch(ctx);
        expect(model.calls).toBe(0);
        expect(out.failed).toBe(true);
        expect(out.patchedContent).toBe(FILE);
        expect(JSON.stringify(ctx.result.diagnostics)).toMatch(/matches 2 lines.*2.*3|lines 2, 3/i);
    });
    it('fails with a clear message when the anchor is not in the file', async () => {
        const ctx = context('Directly after the line `export const nothing = 0;` add the line `export const half = 0.5;`.');
        const out = await generateFilePatch(ctx);
        expect(model.calls).toBe(0);
        expect(out.failed).toBe(true);
        expect(JSON.stringify(ctx.result.diagnostics)).toMatch(/anchor.*not (found|in)/i);
    });
    it('a goal without an anchor still goes to the model', async () => {
        await generateFilePatch(context('Make two return 3.'));
        expect(model.calls).toBeGreaterThan(0);
    });
});
