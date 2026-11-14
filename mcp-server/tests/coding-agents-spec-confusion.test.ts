import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { searchComesFromTests } from '../src/tools/coding-agents/verify-guard.js';
import { generateFilePatch } from '../src/tools/coding-agents/generate-file-patch.js';
import type { CodingAgentsInput, CodingAgentsResult } from '../src/tools/coding-agents/types.js';

// Issue #126: the tests a verifyCommand runs are shown to the model as a read-only specification, and a small model
// copied its SEARCH text from them instead of from the file it had to edit. The pipeline knows both texts, so the
// retry can say exactly that.

const TESTS = "--- tests/a.test.ts ---\nimport { describe, it, expect } from 'vitest';\nimport { plus } from '../src/a.js';\n\ndescribe('plus', () => {\n  it('adds up', () => { expect(plus(1, 2)).toBe(3); });\n});\n";

describe('searchComesFromTests', () => {
    it('is true when a substantial SEARCH line is a line of the tests', () => {
        expect(searchComesFromTests("import { plus } from '../src/a.js';", TESTS)).toBe(true);
        expect(searchComesFromTests("import { describe, it, expect } from 'vitest';\nimport { plus } from '../src/a.js';", TESTS)).toBe(true);
    });
    it('ignores indentation', () => {
        expect(searchComesFromTests("    it('adds up', () => { expect(plus(1, 2)).toBe(3); });", TESTS)).toBe(true);
    });
    it('is false for text that only the file being edited has', () => {
        expect(searchComesFromTests('export function plus(a: number, b: number) {', TESTS)).toBe(false);
    });
    it('is false for short or generic lines that every file has', () => {
        expect(searchComesFromTests('});', TESTS)).toBe(false);
        expect(searchComesFromTests('}', TESTS)).toBe(false);
        expect(searchComesFromTests('', TESTS)).toBe(false);
    });
    it('is false when there is no test context', () => {
        expect(searchComesFromTests("import { plus } from '../src/a.js';", '')).toBe(false);
    });
});

const model = vi.hoisted(() => ({ calls: [] as Array<{ instruction: string }>, replies: [] as string[] }));
vi.mock('../src/tools/local-llm-patch.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    localLlmPatch: async (req: { instruction: string }) => {
        model.calls.push({ instruction: req.instruction });
        return { success: true, patch: model.replies.shift() ?? '' };
    },
}));

const SRC = 'export function plus(a: number, b: number) {\n  return a - b;\n}\n';
const block = (s: string, r: string) => `<<<<<<< SEARCH\n${s}\n=======\n${r}\n>>>>>>> REPLACE`;

describe('the retry says when the SEARCH came from the tests', () => {
    let ws = '';
    beforeAll(() => {
        ws = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-confusion-'));
        fs.mkdirSync(path.join(ws, 'src')); fs.mkdirSync(path.join(ws, 'tests'));
        fs.writeFileSync(path.join(ws, 'src/a.ts'), SRC);
        fs.writeFileSync(path.join(ws, 'tests/a.test.ts'), TESTS.replace('--- tests/a.test.ts ---\n', ''));
    });
    afterAll(() => fs.rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    beforeEach(() => { model.calls.length = 0; model.replies.length = 0; });

    function context() {
        const result = { sessionId: 's', goal: 'g', pipelineStage: 'locate', relevantFiles: [], anchors: [], patchPlan: [], patchSummary: '', diagnostics: [], applied: false } as unknown as CodingAgentsResult;
        return {
            input: { goal: 'make plus return a + b', verifyCommand: 'npx vitest run tests/a.test.ts' } as CodingAgentsInput, result, relPath: 'src/a.ts', fullPath: path.join(ws, 'src/a.ts'), workspaceRoot: ws, sessionId: 's',
            resolvedModel: 'fake-model', originalContent: SRC, activeGoal: 'make plus return a + b',
            changeFiles: ['src/a.ts'], runContents: new Map<string, string>(), editedInRun: new Set<string>(),
        };
    }

    it('the second prompt names the tests as the source of the SEARCH and the file to edit', async () => {
        model.replies.push(block("import { plus } from '../src/a.js';", "import { plus } from '../src/a.ts';"), block('  return a - b;', '  return a + b;'));
        const out = await generateFilePatch(context());
        expect(model.calls.length).toBeGreaterThanOrEqual(2);
        expect(model.calls[0].instruction).not.toMatch(/copied from the read-only test/i);
        expect(model.calls[1].instruction).toMatch(/copied from the read-only test/i);
        expect(model.calls[1].instruction).toContain('src/a.ts');
        expect(out.patchedContent).toContain('return a + b;');
    });

    it('an ordinary miss does not get that sentence', async () => {
        model.replies.push(block('  return subtract(a, b);', '  return a + b;'), block('  return a - b;', '  return a + b;'));
        await generateFilePatch(context());
        expect(model.calls[1].instruction).not.toMatch(/copied from the read-only test/i);
    });
});
