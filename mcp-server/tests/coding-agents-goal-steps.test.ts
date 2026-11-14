import { describe, it, expect } from 'vitest';
import { splitSteps } from '../src/tools/coding-agents/goal-steps.js';
import { runWithRepairLoop } from '../src/tools/coding-agents/repair-loop.js';
import type { CodingAgentsInput, CodingAgentsResult } from '../src/tools/coding-agents/types.js';

// #119: "Step 1: ... Step 2: ..." was sent as one edit and the model did only the first.

describe('splitSteps', () => {
    it('splits Step, Edit and Change markers and keeps the intro on each step', () => {
        expect(splitSteps('In a.ts: Step 1: rename x. Step 2: rename y.')).toEqual(['In a.ts: rename x.', 'In a.ts: rename y.']);
        expect(splitSteps('EDIT 1: do a. EDIT 2: do b. EDIT 3: do c.')).toEqual(['do a.', 'do b.', 'do c.']);
        expect(splitSteps('CHANGE 1: do a. CHANGE 2: do b.')).toEqual(['do a.', 'do b.']);
    });
    it('does not split on a marker inside backticks', () => {
        expect(splitSteps('Set the label to `Step 1: go` in a.ts')).toEqual([]);
    });
    it('returns nothing for one step or none', () => {
        expect(splitSteps('Step 1: only one.')).toEqual([]);
        expect(splitSteps('Make it faster.')).toEqual([]);
    });
});

describe('the repair loop runs steps in order', () => {
    const base: CodingAgentsInput = { goal: 'In a.ts: Step 1: do a. Step 2: do b. Step 3: do c.', dryRun: false, verifyCommand: 'node t.js', resolve: { action: 'apply' }, maxRepairAttempts: 0, samples: 1 };
    const result = (n: number, red: boolean, withCheck: boolean): CodingAgentsResult => ({
        sessionId: 's', goal: 'g', pipelineStage: 'completed', relevantFiles: [], anchors: [], patchPlan: [], patchSummary: '', diagnostics: [],
        applied: true, checkpointId: `cp${n}`, status: 'applied',
        ...(withCheck ? { verification: { command: 'c', status: red ? 'not_green' : 'passed', ok: !red, baselineOk: false, exitCode: red ? 1 : 0, timedOut: false, outputTail: '', durationMs: 1, failedCases: red ? ['t'] : [], ...(red ? { repairBrief: 'red' } : {}) } } : {}),
    } as unknown as CodingAgentsResult);

    async function run(red: boolean, input = base) {
        const seen: CodingAgentsInput[] = [];
        const rolled: string[] = [];
        const r = await runWithRepairLoop(input, 's', undefined, async i => { seen.push(i); return result(seen.length, red, !!i.verifyCommand); }, async cp => { rolled.push(cp); return ['a.ts']; });
        return { r, seen, rolled };
    }

    it('sends one step per attempt and runs the check only after the last', async () => {
        const { r, seen } = await run(false);
        expect(seen.map(i => i.goal)).toEqual(['In a.ts: do a.', 'In a.ts: do b.', 'In a.ts: do c.']);
        expect(seen.map(i => i.verifyCommand)).toEqual([undefined, undefined, 'node t.js']);
        expect(r.repair?.outcome).toBe('converged');
        expect(r.goal).toBe('g');
        expect(r.applied).toBe(true);
    });
    it('a red check after the last step restores the state from before step 1', async () => {
        const { r, rolled } = await run(true);
        expect(rolled).toContain('cp1');
        expect(r.applied).toBe(false);
        expect(r.status).toBe('rollback');
        expect(r.message).toMatch(/step/i);
    });
    it('a goal without steps runs once', async () => {
        const { seen } = await run(false, { ...base, goal: 'Make it faster.' });
        expect(seen).toHaveLength(1);
    });
    it('exact edits are not split', async () => {
        const { seen } = await run(false, { ...base, edits: [] });
        expect(seen).toHaveLength(1);
    });
});
