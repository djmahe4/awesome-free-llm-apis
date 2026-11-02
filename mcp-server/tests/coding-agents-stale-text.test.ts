import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { staleLiterals } from '../src/tools/coding-agents/work-order.js';
import { unfinishedBrief } from '../src/tools/coding-agents/work-order-decision.js';
import { generateFilePatch } from '../src/tools/coding-agents/generate-file-patch.js';
import type { CodingAgentsInput, CodingAgentsResult } from '../src/tools/coding-agents/types.js';

// #120: a goal that says replace X with Y is unfinished while X is still in the file.
// #148: a localized edit in a large module never regenerates the whole file in the cloud.

const GOAL = 'In a.ts replace `return oldValue;` with `return newValue;`.';

describe('staleLiterals', () => {
    it('names the replaced text that is still there', () => {
        expect(staleLiterals(GOAL, ['return oldValue;\nreturn newValue;'])).toEqual(['return oldValue;']);
        expect(staleLiterals(GOAL, ['return newValue;'])).toEqual([]);
    });
    it('does not flag text the new code contains', () => {
        expect(staleLiterals('Replace `const value` with `export const value`.', ['export const value = 1;'])).toEqual([]);
    });
    it('is empty for a negated goal, or one that is not a replacement', () => {
        expect(staleLiterals('Do not replace `return oldValue;` with `return newValue;`.', ['return oldValue;'])).toEqual([]);
        expect(staleLiterals('Make it faster', ['x'])).toEqual([]);
    });
});

describe('unfinishedBrief', () => {
    it('says the old text must go', () => {
        const brief = unfinishedBrief(GOAL, [{ fullPatchedContent: 'return oldValue;\nreturn newValue;' }]);
        expect(brief).toMatch(/still in the file/i);
        expect(brief).toContain('return oldValue;');
    });
    it('is undefined when the replacement is complete', () => {
        expect(unfinishedBrief(GOAL, [{ fullPatchedContent: 'return newValue;' }])).toBeUndefined();
    });
});

describe('cloud full-file fallback', () => {
    afterEach(() => vi.restoreAllMocks());

    async function cloudCalls(lineCount: number) {
        const lp = await import('../src/tools/local-llm-patch.js');
        vi.spyOn(lp, 'localLlmPatch').mockResolvedValue({ success: false, error: 'nothing usable' } as any);
        const cloud = await import('../src/tools/use-free-llm.js');
        const spy = vi.spyOn(cloud, 'useFreeLLM').mockResolvedValue({ choices: [{ message: { content: '' } }] } as any);
        spy.mockClear();
        const content = 'export const a = 1;\n' + 'const filler = 0;\n'.repeat(lineCount);
        const result = { sessionId: 's', goal: 'g', pipelineStage: 'locate', relevantFiles: [], anchors: [], patchPlan: [], patchSummary: '', diagnostics: [], applied: false } as unknown as CodingAgentsResult;
        const ws = path.resolve('some-workspace');
        await generateFilePatch({
            input: { goal: 'Set a to 2', allowCloudFallback: true } as CodingAgentsInput, result, relPath: 'a.ts', fullPath: path.join(ws, 'a.ts'), workspaceRoot: ws, sessionId: 's',
            resolvedModel: 'fake', originalContent: content, activeGoal: 'Set a to 2', changeFiles: ['a.ts'], runContents: new Map(), editedInRun: new Set(),
        });
        return spy.mock.calls.length;
    }

    it('is skipped for a large module, so only the search/replace call is made', async () => {
        expect(await cloudCalls(400)).toBe(1);
    }, 30000);
    it('still runs for a small file', async () => {
        expect(await cloudCalls(10)).toBeGreaterThan(1);
    }, 30000);
});
