import { describe, it, expect } from 'vitest';
import { filesImplicated, runWithRepairLoop } from '../src/tools/coding-agents/repair-loop.js';
import type { CodingAgentsInput, CodingAgentsResult } from '../src/tools/coding-agents/types.js';

// Traced in the 3x cross-file runs: the 7B was stuck on one case ("cart uses its currency everywhere"),
// and every repair re-edited all three files; one of them broke the already-correct money.js. A repair
// now edits only the files the failure points at (Agentless-style localization).

const TARGETS = ['src/money.js', 'src/cart.js', 'src/invoice.js'];

describe('filesImplicated', () => {
    it('a failing test named after a file implicates that file', () => {
        expect(filesImplicated(TARGETS, ['cart uses its currency everywhere'], '')).toEqual(['src/cart.js']);
    });

    it('a stack frame inside a target file implicates it', () => {
        const brief = 'Frames in your edit:\nat Object.<anonymous> (C:\\tmp\\ws\\src\\invoice.js:2:17)';
        expect(filesImplicated(TARGETS, ['tests\\currency.test.js'], brief)).toEqual(['src/invoice.js']);
    });

    it('nothing specific (or everything) implicated means no narrowing', () => {
        expect(filesImplicated(TARGETS, ['EUR uses a comma and a trailing euro sign'], '')).toEqual([]);
        expect(filesImplicated(TARGETS, ['money cart invoice all broken'], '')).toEqual([]);
        expect(filesImplicated(['src/cart.js'], ['cart uses its currency'], '')).toEqual([]);
    });
});

const notGreen = (brief: string, failedCases: string[]): CodingAgentsResult => ({
    sessionId: 's', goal: 'g', pipelineStage: 'completed', relevantFiles: TARGETS, anchors: [], patchPlan: [], patchSummary: '', diagnostics: [],
    applied: true, checkpointId: 'cp1',
    verification: { command: 'c', status: 'not_green', ok: false, baselineOk: false, exitCode: 1, timedOut: false, outputTail: '', durationMs: 1, repairBrief: brief, failedCases },
});

describe('repair loop localizes retries', () => {
    it('a near-miss retry edits only the implicated file; a later all-green pass is unaffected', async () => {
        const input: CodingAgentsInput = { goal: 'x', dryRun: false, verifyCommand: 'node t.js', resolve: { action: 'apply' }, targetFiles: TARGETS, maxRepairAttempts: 2, samples: 1 };
        const seen: Array<string[] | undefined> = [];
        const related: Array<string[] | undefined> = [];
        let n = 0;
        await runWithRepairLoop(input, 's', undefined, async (i) => {
            seen.push(i.targetFiles);
            related.push((i as any).relatedFiles);
            n++;
            return notGreen(`failure ${n}`, ['cart uses its currency everywhere']);
        });
        expect(seen[0]).toEqual(TARGETS);
        expect(seen[1]).toEqual(['src/cart.js']);
        // the files it no longer edits stay visible as reference (their API surface)
        expect(related[1]).toEqual(['src/money.js', 'src/invoice.js']);
    });
});
