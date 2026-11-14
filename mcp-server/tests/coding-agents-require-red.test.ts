import { describe, it, expect } from 'vitest';
import { runWithRepairLoop } from '../src/tools/coding-agents/repair-loop.js';
import type { CodingAgentsInput, CodingAgentsResult } from '../src/tools/coding-agents/types.js';

// A check that already passes before the edit proves nothing about the edit. With requireRed set, such a run is
// reported as unverified instead of converged.

const green = (baselineOk: boolean): CodingAgentsResult => ({
    sessionId: 's', goal: 'g', pipelineStage: 'completed', relevantFiles: [], anchors: [], patchSummary: '', diagnostics: [],
    patchPlan: [{ filePath: 'a.ts', fullPatchedContent: 'x', unchanged: false }], applied: true, checkpointId: 'cp1', status: 'applied',
    verification: { command: 'c', status: 'passed', ok: true, baselineOk, exitCode: 0, timedOut: false, outputTail: '', durationMs: 1, failedCases: [] },
} as unknown as CodingAgentsResult);

const base = (extra: Partial<CodingAgentsInput> = {}): CodingAgentsInput => ({
    goal: 'Make it faster.', dryRun: false, verifyCommand: 'node t.js', resolve: { action: 'apply' }, maxRepairAttempts: 1, samples: 1, ...extra,
});

describe('requireRed', () => {
    it('a check that failed before the edit and passes now converges', async () => {
        const r = await runWithRepairLoop(base({ requireRed: true }), 's', undefined, async () => green(false), async () => []);
        expect(r.repair?.outcome).toBe('converged');
    });
    it('a check that already passed before the edit is unverified, and says so', async () => {
        const r = await runWithRepairLoop(base({ requireRed: true }), 's', undefined, async () => green(true), async () => []);
        expect(r.repair?.outcome).toBe('unverified');
        expect(r.message ?? '').toMatch(/already passed|did not fail before/i);
    });
    it('keeps the edit applied when unverified', async () => {
        const r = await runWithRepairLoop(base({ requireRed: true }), 's', undefined, async () => green(true), async () => []);
        expect(r.applied).toBe(true);
    });
    it('without the flag a check that already passed still converges', async () => {
        const r = await runWithRepairLoop(base(), 's', undefined, async () => green(true), async () => []);
        expect(r.repair?.outcome).toBe('converged');
    });
    it('probes the caller supplied make a green check count', async () => {
        const r = await runWithRepairLoop(base({ requireRed: true, hasPostConditions: true }), 's', undefined, async () => green(true), async () => []);
        expect(r.repair?.outcome).toBe('converged');
    });
});
