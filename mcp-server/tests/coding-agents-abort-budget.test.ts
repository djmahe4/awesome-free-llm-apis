import { describe, it, expect } from 'vitest';
import { runWithRepairLoop } from '../src/tools/coding-agents/repair-loop.js';
import { looksLikeHallucinatedReplacement } from '../src/tools/coding-agents/patch-gen.js';
import type { CodingAgentsInput, CodingAgentsResult } from '../src/tools/coding-agents/types.js';

// Dogfooding found: abort did not stop the repair loop (the file kept being rewritten), nothing capped
// the wall clock (one tiny goal ran 20+ minutes), a 711-line file was replaced by 102 unrelated lines,
// and the status counter read "2/1 file(s)" because it kept counting across attempts.

const notGreen = (brief: string): CodingAgentsResult => ({
    sessionId: 's', goal: 'g', pipelineStage: 'completed', relevantFiles: [], anchors: [], patchPlan: [], patchSummary: '', diagnostics: [],
    applied: true, checkpointId: 'cp1',
    verification: { command: 'c', status: 'not_green', ok: false, baselineOk: false, exitCode: 1, timedOut: false, outputTail: '', durationMs: 1, repairBrief: brief },
});
const input: CodingAgentsInput = { goal: 'x', dryRun: false, verifyCommand: 'node t.js', resolve: { action: 'apply' }, maxRepairAttempts: 4 };
const fakeRun = (extra: Record<string, unknown> = {}) => ({ sessionId: 's', startedAt: Date.now(), controller: new AbortController(), done: false, completedCount: 0, totalCount: 1, ...extra }) as any;

describe('repair loop abort', () => {
    it('stops after the attempt in flight, restores the original tree and reports aborted', async () => {
        const run = fakeRun();
        const rolledBack: string[] = [];
        let calls = 0;
        const r = await runWithRepairLoop(input, 's', run, async () => { calls++; run.controller.abort(); return notGreen('still failing'); },
            async (cp) => { rolledBack.push(cp); return ['a.ts']; });
        expect(calls).toBe(1);
        expect(r.repair?.outcome).toBe('aborted');
        expect(rolledBack).toEqual(['cp1']);
        expect(r.applied).toBe(false);
    });

    it('an abort before the first attempt runs nothing', async () => {
        const run = fakeRun();
        run.controller.abort();
        let calls = 0;
        const r = await runWithRepairLoop(input, 's', run, async () => { calls++; return notGreen('x'); });
        expect(calls).toBe(0);
        expect(r.repair?.outcome).toBe('aborted');
    });
});

describe('repair loop wall-clock budget', () => {
    it('stops with timed_out once maxDurationMs is spent and restores the original', async () => {
        const rolledBack: string[] = [];
        let calls = 0;
        const r = await runWithRepairLoop({ ...input, maxDurationMs: 40 }, 's', undefined, async () => {
            calls++;
            await new Promise(res => setTimeout(res, 60));
            return notGreen(`failure ${calls}`);
        }, async (cp) => { rolledBack.push(cp); return []; });
        expect(calls).toBe(1);
        expect(r.repair?.outcome).toBe('timed_out');
        expect(rolledBack).toEqual(['cp1']);
        expect(r.applied).toBe(false);
        expect(r.message).toMatch(/time budget/i);
    });

    it('defaults to a finite budget (5 minutes) so a run can never be unbounded', async () => {
        const r = await runWithRepairLoop(input, 's', undefined, async () => notGreen('x'));
        expect(r.repair?.outcome).not.toBe('timed_out');
    });
});

describe('status counter', () => {
    it('is reset for every attempt so it never reads 2/1 file(s)', async () => {
        const run = fakeRun({ completedCount: 7 });
        const seen: number[] = [];
        let n = 0;
        await runWithRepairLoop({ ...input, maxRepairAttempts: 2 }, 's', run, async (_i, _s, r) => {
            seen.push(r!.completedCount);
            r!.completedCount++;
            return notGreen(`failure ${++n}`);
        });
        expect(seen).toEqual([0, 0, 0]);
    });
});

describe('whole-file replacement guard', () => {
    const big = Array.from({ length: 300 }, (_, i) => (i === 0 ? 'export function keep() { return 1; }' : `  const line${i} = ${i};`)).join('\n');

    it('rejects a replacement that keeps a symbol but drops most of the file', () => {
        const shrunk = 'export function keep() { return 1; }\n' + Array.from({ length: 30 }, (_, i) => `  const a${i} = ${i};`).join('\n');
        expect(looksLikeHallucinatedReplacement(big, shrunk)).toBe(true);
    });

    it('accepts a normal edit of the same file', () => {
        expect(looksLikeHallucinatedReplacement(big, big.replace('return 1', 'return 2'))).toBe(false);
    });

    it('does not apply to small files', () => {
        const small = 'export function keep() { return 1; }\nconst a = 1;\nconst b = 2;';
        expect(looksLikeHallucinatedReplacement(small, 'export function keep() { return 1; }')).toBe(false);
    });
});
