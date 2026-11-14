import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applySearchReplaceBlocks, isEndOfFileInstruction } from '../src/tools/coding-agents/patch-gen.js';
import { generateFilePatch } from '../src/tools/coding-agents/generate-file-patch.js';
import type { CodingAgentsInput, CodingAgentsResult } from '../src/tools/coding-agents/types.js';

// Issue #125: allowAppend existed but nothing turned it on, so adding code at the end of a file needed an invented
// anchor. A goal that says "at the end of the file" now allows an empty SEARCH, and says so in the instruction.

const model = vi.hoisted(() => ({ calls: [] as Array<{ instruction: string; skipContextGathering?: boolean }>, replies: [] as string[] }));
vi.mock('../src/tools/local-llm-patch.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    localLlmPatch: async (req: { instruction: string; skipContextGathering?: boolean }) => {
        model.calls.push({ instruction: req.instruction, skipContextGathering: req.skipContextGathering });
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

    it('stops patch generation rather than dropping oversized refuted evidence', async () => {
        const ctx: any = context('Implement the active task.');
        ctx.result.hypotheses = [{ id: 'h1', claim: 'A proposed write path is unsafe', probe: 'grep:write', status: 'refuted', evidence: `EVIDENCE-BEGIN ${'E'.repeat(1700)} EVIDENCE-END` }];

        const out = await generateFilePatch(ctx);

        expect(out.failed).toBe(true);
        expect(out.patchedContent).toBe(FILE);
        expect(model.calls).toHaveLength(0);
        expect(ctx.result.diagnostics.at(-1).message).toMatch(/rather than dropping validator evidence/);
    });

    it('stops patch generation when pinned DAG context exceeds its budget', async () => {
        const ctx: any = context('Implement the active task.');
        const task = { id: 'task-active', task: 'Implement the active task', status: 'in_progress', context: 'Critical constraint '.repeat(150), log: [] };
        Object.assign(ctx, { loadedTasks: [task], nextPendingTask: task });

        const out = await generateFilePatch(ctx);

        expect(out.failed).toBe(true);
        expect(out.patchedContent).toBe(FILE);
        expect(model.calls).toHaveLength(0);
        expect(ctx.result.diagnostics.at(-1).message).toMatch(/rather than truncating the contract/);
    });

    it('stops when an explicitly requested DAG task cannot fit without truncation', async () => {
        const ctx: any = context('Implement the active task.');
        const active = { id: 'task-active', task: 'Implement current task', status: 'in_progress', log: [] };
        const requested = { id: 'task-history', task: 'Preserve historical task contract', status: 'completed', context: `HISTORICAL-CONTRACT-BEGIN ${'H'.repeat(2500)} HISTORICAL-CONTRACT-END`, log: [] };
        Object.assign(ctx, {
            loadedTasks: [active, requested],
            nextPendingTask: active,
            input: { ...ctx.input, contextWindow: { radius: 0, taskIds: ['task-history'] } },
        });

        const out = await generateFilePatch(ctx);

        expect(out.failed).toBe(true);
        expect(model.calls).toHaveLength(0);
        expect(ctx.result.diagnostics.at(-1).message).toMatch(/rather than truncating the contract/);
    });

    it('does not skip generic retrieval when DAG context lacks matching source excerpts', async () => {
        const ctx: any = context('Use the planner-only marker ZZQ-73 when describing the contract.');
        const task = { id: 'task-active', task: 'Implement the planner-only marker', status: 'in_progress', context: 'Keep existing behavior unchanged.', log: [] };
        Object.assign(ctx, { loadedTasks: [task], nextPendingTask: task });
        model.replies.push('<<<<<<< SEARCH\nexport function one() {\n  return 1;\n}\n=======\nexport function one() {\n  return 3;\n}\n>>>>>>> REPLACE');

        await generateFilePatch(ctx);

        expect(model.calls[0].instruction).toContain('[DAG Context]');
        expect(model.calls[0].instruction).toContain('OVERALL OBJECTIVE:\nUse the planner-only marker ZZQ-73');
        expect(model.calls[0].instruction).not.toContain('[Current source excerpts:');
        expect(model.calls[0].skipContextGathering).toBe(false);
    });

    it('grounds a new-file task with live source contracts and compact DAG state', async () => {
        const harness = path.join(ws, 'src', 'harness');
        fs.mkdirSync(harness, { recursive: true });
        fs.writeFileSync(path.join(harness, 'dir-scanner.ts'), 'export class WorkspaceDirScanner { scanDir() { return { folders: [] }; } }\n');
        fs.writeFileSync(path.join(harness, 'file-outline.ts'), 'export class FileStructureDag { updateFile(filePath: string, source: string) {} }\n');
        fs.writeFileSync(path.join(harness, 'zed-reader.ts'), 'export const placeholder = 0;\n');
        const goal = 'Implement Zed reader using WorkspaceDirScanner.scanDir and FileStructureDag.updateFile.';
        const ctx: any = context(goal);
        const tasks = [
            { id: 'task-1', task: 'Inspect scanner API', status: 'completed', targetFile: 'src/harness/dir-scanner.ts', log: ['resume#1 outcome=confirmed WorkspaceDirScanner.scanDir'] },
            { id: 'task-2', task: 'Implement Zed reader', status: 'in_progress', targetFile: 'src/harness/zed-reader.ts', context: 'Use WorkspaceDirScanner.scanDir and FileStructureDag.updateFile; keep SQLite read-only.', log: [] },
            { id: 'task-3', task: 'Add reader tests', status: 'pending', targetFile: 'tests/zed-reader.test.ts', context: 'Test schema and errors.', log: [] },
        ];
        ctx.result.hypotheses = [
            { id: 'h1', claim: 'WorkspaceDirScanner is defined by the live scanner', probe: 'defined:WorkspaceDirScanner', status: 'confirmed', evidence: 'mcp-server/src/harness/dir-scanner.ts:L1' },
            { id: 'h2', claim: 'Zed database can be written during scanning', probe: 'grep:write@src/harness/zed-reader.ts', status: 'refuted', evidence: 'reader must be read-only' },
        ];
        Object.assign(ctx, {
            relPath: 'src/harness/zed-reader.ts',
            fullPath: path.join(harness, 'zed-reader.ts'),
            originalContent: 'export const placeholder = 0;\n',
            activeGoal: `${goal}\n\n[Planner context]\n${tasks[1].context}`,
            loadedTasks: tasks,
            nextPendingTask: tasks[1],
            changeFiles: ['src/harness/zed-reader.ts'],
        });
        model.replies.push('<<<<<<< SEARCH\nexport const placeholder = 0;\n=======\nexport const placeholder = 1;\n>>>>>>> REPLACE');

        await generateFilePatch(ctx);

        const instruction = model.calls[0].instruction;
        expect(instruction).toContain('OVERALL OBJECTIVE:\nImplement Zed reader using WorkspaceDirScanner.scanDir');
        expect(instruction).toContain('ACTIVE task-2 target=src/harness/zed-reader.ts');
        expect(instruction).toContain('task-1 target=src/harness/dir-scanner.ts');
        expect(instruction).toContain('outcome=confirmed WorkspaceDirScanner.scanDir');
        expect(instruction).toContain('task-3 target=tests/zed-reader.test.ts');
        expect(instruction).toContain('CONFIRMED: WorkspaceDirScanner is defined by the live scanner');
        expect(instruction).toContain('REFUTED: Zed database can be written during scanning');
        expect(instruction).toContain('reader must be read-only');
        expect(instruction).toContain('export class WorkspaceDirScanner');
        expect(instruction).toContain('scanDir()');
        expect(instruction).toContain('export class FileStructureDag');
        expect(instruction).toContain('updateFile(filePath: string, source: string)');
        expect(model.calls[0].skipContextGathering).toBe(true);
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
