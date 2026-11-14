import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { alreadyAdded } from '../src/tools/coding-agents/work-order.js';
import { noChangeBrief } from '../src/tools/coding-agents/work-order-decision.js';
import { runWithRepairLoop } from '../src/tools/coding-agents/repair-loop.js';
import type { CodingAgentsInput, CodingAgentsResult } from '../src/tools/coding-agents/types.js';

// #145: repeating a goal that only adds lines must not add them again.
// #146: an edit that changes nothing is not converged, whatever the check says.

const LINE = 'const answer = 42;';
const ADD_GOAL = `In a.ts add the line \`${LINE}\`. Change nothing else.`;

const green = (patchPlan: unknown[]): CodingAgentsResult => ({
    sessionId: 's', goal: 'g', pipelineStage: 'completed', relevantFiles: [], anchors: [], patchSummary: '', diagnostics: [],
    patchPlan, applied: true, checkpointId: 'cp1', status: 'applied',
    verification: { command: 'c', status: 'passed', ok: true, baselineOk: true, exitCode: 0, timedOut: false, outputTail: '', durationMs: 1, failedCases: [] },
} as unknown as CodingAgentsResult);

describe('alreadyAdded', () => {
    it('is true when a goal that adds lines finds them all', () => {
        expect(alreadyAdded(ADD_GOAL, [`x\n  ${LINE}\n`])).toBe(true);
    });
    it('is false when a line is missing', () => {
        expect(alreadyAdded(ADD_GOAL, ['x'])).toBe(false);
    });
    it('is false for a goal that is not an addition', () => {
        expect(alreadyAdded(`Replace \`old line;\` with \`${LINE}\`.`, [LINE])).toBe(false);
        expect(alreadyAdded('Make it faster.', ['x'])).toBe(false);
    });
});

describe('noChangeBrief', () => {
    it('speaks up only when every patch is unchanged', () => {
        expect(noChangeBrief([{ unchanged: true }, { unchanged: true }])).toMatch(/changed nothing/i);
        expect(noChangeBrief([{ unchanged: true }, { unchanged: false }])).toBeUndefined();
        expect(noChangeBrief([{}])).toBeUndefined();
        expect(noChangeBrief([])).toBeUndefined();
    });
});

describe('the repair loop', () => {
    let root: string;
    beforeAll(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-nochange-'));
        await fs.writeFile(path.join(root, 'done.ts'), `${LINE}\n`);
        await fs.writeFile(path.join(root, 'todo.ts'), 'const other = 1;\n');
    });
    afterAll(() => fs.rm(root, { recursive: true, force: true }));

    const base = (): CodingAgentsInput => ({ goal: 'Make it faster.', dryRun: false, verifyCommand: 'node t.js', resolve: { action: 'apply' }, maxRepairAttempts: 1, samples: 1 });

    it('does not run a goal whose added lines are already in the target files', async () => {
        let calls = 0;
        const r = await runWithRepairLoop({ ...base(), goal: ADD_GOAL, workspaceRoot: root, targetFiles: ['done.ts'] }, 's', undefined, async () => { calls++; return green([]); }, async () => []);
        expect(calls).toBe(0);
        expect(r.applied).toBe(false);
        expect(r.message).toMatch(/already/i);
    });
    it('runs when a line is missing', async () => {
        let calls = 0;
        await runWithRepairLoop({ ...base(), goal: ADD_GOAL, workspaceRoot: root, targetFiles: ['todo.ts'] }, 's', undefined, async () => { calls++; return green([{ filePath: 'todo.ts', fullPatchedContent: LINE }]); }, async () => []);
        expect(calls).toBe(1);
    });
    it('retries an unchanged edit and does not call it converged', async () => {
        const inputs: CodingAgentsInput[] = [];
        const r = await runWithRepairLoop(base(), 's', undefined, async i => { inputs.push(i); return green([{ filePath: 'a.ts', fullPatchedContent: 'x', unchanged: true }]); }, async () => []);
        expect(inputs).toHaveLength(2);
        expect(String(inputs[1].feedback)).toMatch(/changed nothing/i);
        expect(r.repair?.outcome).not.toBe('converged');
    });
    it('a real change with a green check converges', async () => {
        const r = await runWithRepairLoop(base(), 's', undefined, async () => green([{ filePath: 'a.ts', fullPatchedContent: 'x', unchanged: false }]), async () => []);
        expect(r.repair?.outcome).toBe('converged');
    });
});
