import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { anchoredWindow } from '../src/tools/coding-agents/anchored-edit.js';
import { generateFilePatch } from '../src/tools/coding-agents/generate-file-patch.js';
import { decomposeGoalIntelligently } from '../src/tools/coding-agents/tasks.js';
import type { CodingAgentsInput, CodingAgentsResult } from '../src/tools/coding-agents/types.js';

// #148: a goal that quotes a line of a long file shows the model a small window around it, wider on the retry.
// #151: the plan flow reads Step goals with the same splitter as the repair loop.

const model = vi.hoisted(() => ({ overrides: [] as string[] }));
vi.mock('../src/tools/local-llm-patch.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    localLlmPatch: async (req: { contentOverride?: string }) => { model.overrides.push(String(req.contentOverride)); return { success: true, patch: 'no blocks here' }; },
}));

const LONG = Array.from({ length: 400 }, (_, i) => `const value${i} = ${i};`).join('\n');
const GOAL = 'Change `const value200 = 200;` so that it holds 201.';

describe('anchoredWindow', () => {
    it('centres on the one line the goal quotes, 20 lines first and 60 on the retry', () => {
        const first = anchoredWindow(LONG, GOAL, 0);
        expect(first?.window.split('\n')).toHaveLength(20);
        expect(first?.window).toContain('const value200 = 200;');
        expect(first).toMatchObject({ startIdx: 190, endIdx: 210, lineCount: 400 });
        expect(anchoredWindow(LONG, GOAL, 1)?.window.split('\n')).toHaveLength(60);
    });
    it('is null when the quote matches no line or several, or nothing is quoted', () => {
        expect(anchoredWindow(LONG, 'Change `const missing = 0;` now', 0)).toBeNull();
        expect(anchoredWindow(`${LONG}\nconst value200 = 200;`, GOAL, 0)).toBeNull();
        expect(anchoredWindow(LONG, 'Make it faster', 0)).toBeNull();
    });
    it('skips a short quote and looks at the next one', () => {
        expect(anchoredWindow(LONG, 'Set `x` in `const value200 = 200;`', 0)?.window).toContain('value200');
    });
});

describe('generateFilePatch', () => {
    beforeEach(() => { model.overrides = []; });
    it('sends the small window, then the wider one', async () => {
        const result = { sessionId: 's', goal: GOAL, pipelineStage: 'locate', relevantFiles: [], anchors: [], patchPlan: [], patchSummary: '', diagnostics: [], applied: false } as unknown as CodingAgentsResult;
        const ws = path.resolve('some-workspace');
        await generateFilePatch({
            input: { goal: GOAL } as CodingAgentsInput, result, relPath: 'a.ts', fullPath: path.join(ws, 'a.ts'), workspaceRoot: ws, sessionId: 's',
            resolvedModel: 'fake', originalContent: LONG, activeGoal: GOAL, changeFiles: ['a.ts'], runContents: new Map(), editedInRun: new Set(),
        });
        expect(model.overrides[0].split('\n')).toHaveLength(20);
        expect(model.overrides[1].split('\n')).toHaveLength(60);
    });
});

describe('plan flow', () => {
    afterEach(() => vi.restoreAllMocks());
    it('splits a Step goal into tasks', async () => {
        const cloud = await import('../src/tools/use-free-llm.js');
        vi.spyOn(cloud, 'useFreeLLM').mockRejectedValue(new Error('offline'));
        const tasks = await decomposeGoalIntelligently('Step 1: rename a. Step 2: rename b.', path.resolve('some-workspace'), [], 's');
        expect(tasks.map(t => t.task)).toEqual(['rename a.', 'rename b.']);
    });
});
