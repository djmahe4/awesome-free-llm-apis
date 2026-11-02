import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { applySearchReplaceBlocks } from '../src/tools/coding-agents/patch-gen.js';
import { generateFilePatch } from '../src/tools/coding-agents/generate-file-patch.js';
import type { CodingAgentsInput, CodingAgentsResult } from '../src/tools/coding-agents/types.js';

// #121: does anything between the goal and the file turn a typed backslash-n into a line break?

const model = vi.hoisted(() => ({ instructions: [] as string[], reply: '' }));
vi.mock('../src/tools/local-llm-patch.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    localLlmPatch: async (req: { instruction: string }) => { model.instructions.push(req.instruction); return { success: true, patch: model.reply }; },
}));

const BS_N = String.raw`'\n'`;
const FILE = 'export function f(s: string) {\n  return s;\n}\n';

describe('a typed backslash-n', () => {
    beforeEach(() => { model.instructions = []; });

    it('survives applying a block', () => {
        const r = applySearchReplaceBlocks(FILE, [{ search: '  return s;', replace: `  return s.split(${BS_N});` }]);
        expect(r.content).toContain(`s.split(${BS_N})`);
    });
    it('reaches the model unchanged and is written unchanged', async () => {
        model.reply = `<<<<<<< SEARCH\n  return s;\n=======\n  return s.split(${BS_N});\n>>>>>>> REPLACE`;
        const goal = `Make f return s.split(${BS_N})`;
        const result = { sessionId: 's', goal, pipelineStage: 'locate', relevantFiles: [], anchors: [], patchPlan: [], patchSummary: '', diagnostics: [], applied: false } as unknown as CodingAgentsResult;
        const ws = path.resolve('some-workspace');
        const out = await generateFilePatch({
            input: { goal } as CodingAgentsInput, result, relPath: 'a.ts', fullPath: path.join(ws, 'a.ts'), workspaceRoot: ws, sessionId: 's',
            resolvedModel: 'fake', originalContent: FILE, activeGoal: goal, changeFiles: ['a.ts'], runContents: new Map(), editedInRun: new Set(),
        });
        expect(model.instructions[0]).toContain(BS_N);
        expect(out.patchedContent).toContain(`s.split(${BS_N})`);
    });
});
