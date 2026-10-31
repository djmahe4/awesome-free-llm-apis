import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runWithRepairLoop } from '../src/tools/coding-agents/repair-loop.js';
import { buildRepairBrief, deletedLines } from '../src/tools/coding-agents/verify-guard.js';
import { cachedVerify, resetVerifyCache } from '../src/tools/coding-agents/verify-cache.js';
import type { CodingAgentsInput, CodingAgentsResult } from '../src/tools/coding-agents/types.js';

// Found by using coding_agents on its own repository (issues #105, #106, #108, #109).

const input: CodingAgentsInput = { goal: 'x', dryRun: false, verifyCommand: 'node t.js', resolve: { action: 'apply' }, maxRepairAttempts: 6, samples: 1 };

const red = (cases: string[]): CodingAgentsResult => ({
    sessionId: 's', goal: 'g', pipelineStage: 'completed', relevantFiles: [], anchors: [], patchPlan: [], patchSummary: '', diagnostics: [],
    applied: true, checkpointId: 'cp1', status: 'applied',
    verification: { command: 'c', status: 'not_green', ok: false, baselineOk: false, exitCode: 1, timedOut: false, outputTail: '', durationMs: 1, failedCases: cases, repairBrief: `failing: ${cases.join(', ')}` },
} as CodingAgentsResult);

describe('#105: a rolled-back run does not report "applied"', () => {
    it('status is rollback and the markdown says so', async () => {
        const r = await runWithRepairLoop({ ...input, maxRepairAttempts: 1 }, 's', undefined, async () => red(['a fails']), async () => ['src/a.ts']);
        expect(r.applied).toBe(false);
        expect(r.status).toBe('rollback');
        expect(r.content ?? '').not.toMatch(/status:\s*applied/i);
    });
});

describe('#106: going back and forth between the same failures', () => {
    it('starts over once from the original, then stops with cycling', async () => {
        const seq = [['a 4ms'], ['b'], ['a 9ms'], ['b'], ['a'], ['b']];
        let calls = 0;
        const rolled: string[] = [];
        const inputs: CodingAgentsInput[] = [];
        const r = await runWithRepairLoop(input, 's', undefined, async (i) => { inputs.push(i); return red(seq[calls++ % seq.length]); }, async (cp) => { rolled.push(cp); return []; });
        expect(r.repair?.outcome).toBe('cycling');
        expect(calls).toBeLessThan(6);
        // the first repeat starts over from the original, with a note about the cycle
        expect(inputs.some(i => i.rewrite && /back and forth/.test(String(i.feedback)))).toBe(true);
        expect(r.applied).toBe(false);
        expect(r.status).toBe('rollback');
    });
    it('a failing set that keeps shrinking is not a cycle', async () => {
        const seq = [['a', 'b', 'c'], ['a', 'b'], ['a']];
        let calls = 0;
        const r = await runWithRepairLoop({ ...input, maxRepairAttempts: 2 }, 's', undefined, async () => red(seq[Math.min(calls++, 2)]), async () => []);
        expect(r.repair?.outcome).not.toBe('cycling');
    });
});

describe('#109: the brief says what the edit broke and what it deleted', () => {
    it('separates tests that passed before the edit from those that were already red, ignoring durations', () => {
        const brief = buildRepairBrief({
            command: 'npx vitest run t.test.ts', exitCode: 1, outputTail: '', patchedFiles: ['src/g.ts'],
            failedCases: ['a name written as a call counts too 4ms', 'and between spans is not a name 6ms'],
            baselineFailedCases: ['and between spans is not a name 3ms'],
        });
        expect(brief).toMatch(/Your edit broke this test, which passed before it[\s\S]*a name written as a call counts too/);
        expect(brief).toMatch(/Still failing, as before the edit \(1\):\nand between spans is not a name/);
        expect(brief).not.toMatch(/Failing cases \(/);
    });
    it('without a baseline it lists the failing cases as before', () => {
        expect(buildRepairBrief({ command: 'c', exitCode: 1, outputTail: '', patchedFiles: [], failedCases: ['x'] })).toMatch(/Failing cases \(1\):\nx/);
    });
    it('names the lines the edit deleted', () => {
        const brief = buildRepairBrief({ command: 'c', exitCode: 1, outputTail: '', patchedFiles: [], failedCases: ['x'], deletedLines: ['for (const m of goal.matchAll(CALL)) names.push(m[1]);'] });
        expect(brief).toMatch(/Your edit deleted these lines[\s\S]*names\.push/);
    });
    it('deletedLines counts repeats and ignores blank and bracket-only lines', () => {
        const before = 'const a = 1;\n\n  if (x) {\n    run();\n    run();\n  }\nkeep();\n';
        const after = 'const a = 2;\n  if (x) {\n    run();\n  }\nkeep();\n';
        expect(deletedLines(before, after)).toEqual(['const a = 1;', 'run();']);
        expect(deletedLines(null, 'x')).toEqual([]);
    });
});

describe('#108: the same tree is checked once per run', () => {
    let ws = '';
    beforeAll(async () => {
        ws = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-cache-'));
        await fs.writeFile(path.join(ws, 'a.ts'), 'one');
        await fs.writeFile(path.join(ws, 't.test.ts'), 'test');
    });
    afterAll(async () => { await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
    beforeEach(() => resetVerifyCache());

    const ok = { ok: false, exitCode: 1, timedOut: false, outputTail: 'x', failedCases: ['a'], durationMs: 5 };

    it('reuses the result while the edited files and the test file are unchanged', async () => {
        let runs = 0;
        const run = async () => { runs++; return { ...ok }; };
        await cachedVerify('npx vitest run t.test.ts', ws, ['a.ts'], run);
        const second = await cachedVerify('npx vitest run t.test.ts', ws, ['a.ts'], run);
        expect(runs).toBe(1);
        expect(second.cached).toBe(true);
    });
    it('runs again when an edited file or the test file changes', async () => {
        let runs = 0;
        const run = async () => { runs++; return { ...ok }; };
        await cachedVerify('npx vitest run t.test.ts', ws, ['a.ts'], run);
        await fs.writeFile(path.join(ws, 'a.ts'), 'two');
        await cachedVerify('npx vitest run t.test.ts', ws, ['a.ts'], run);
        await fs.writeFile(path.join(ws, 't.test.ts'), 'test 2');
        await cachedVerify('npx vitest run t.test.ts', ws, ['a.ts'], run);
        expect(runs).toBe(3);
    });
    it('never keeps a timed-out run, and a new run starts with an empty cache', async () => {
        let runs = 0;
        const slow = async () => { runs++; return { ...ok, timedOut: true }; };
        await cachedVerify('c', ws, ['a.ts'], slow);
        await cachedVerify('c', ws, ['a.ts'], slow);
        expect(runs).toBe(2);
        const fast = async () => { runs++; return { ...ok }; };
        await cachedVerify('c', ws, ['a.ts'], fast);
        resetVerifyCache();
        await cachedVerify('c', ws, ['a.ts'], fast);
        expect(runs).toBe(4);
    });
});

describe('#106: after a cycle the local model is not asked again when the cloud is allowed', () => {
    it('later attempts carry preferCloud, and only with allowCloudFallback', async () => {
        for (const allow of [true, false]) {
            const seq = [['a'], ['b'], ['a'], ['c'], ['d']];
            let calls = 0;
            const inputs: CodingAgentsInput[] = [];
            await runWithRepairLoop({ ...input, allowCloudFallback: allow }, 's', undefined, async (i) => { inputs.push(i); return red(seq[calls++ % seq.length]); }, async () => []);
            const after = inputs.slice(3);
            expect(after.length).toBeGreaterThan(0);
            expect(after.every(i => i.preferCloud === (allow ? true : undefined))).toBe(true);
            expect(inputs.slice(0, 3).some(i => i.preferCloud)).toBe(false);
        }
    });
});

describe('#117: the baseline only counts when it actually ran the cases', () => {
    const load = async () => (await import('../src/tools/coding-agents/verify-guard.js')) as { informativeBaseline?: (b: { ok: boolean; failedCases: string[] }) => string[] | undefined };

    it('a passing baseline has no failing cases', async () => {
        expect((await load()).informativeBaseline?.({ ok: true, failedCases: [] })).toEqual([]);
    });
    it('a failing baseline with case names gives those names', async () => {
        expect((await load()).informativeBaseline?.({ ok: false, failedCases: ['a', 'b'] })).toEqual(['a', 'b']);
    });
    it('a baseline that failed without any case names (the suite did not load) says nothing', async () => {
        expect((await load()).informativeBaseline?.({ ok: false, failedCases: [] })).toBeUndefined();
    });
    it('the brief then keeps the plain list instead of claiming a regression', () => {
        const brief = buildRepairBrief({ command: 'c', exitCode: 1, outputTail: '', patchedFiles: [], failedCases: ['x', 'y'], baselineFailedCases: undefined });
        expect(brief).toMatch(/Failing cases \(2\)/);
        expect(brief).not.toMatch(/broke/);
    });
});

describe('the pipeline feeds the repair brief (wiring)', () => {
    // The pipeline is too large to run end to end here, so this checks the call that builds the brief after an apply.
    // A type check alone let a partial edit through once: the imports were added, the properties were not.
    it('passes the informative baseline and the export gaps into buildRepairBrief', async () => {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync(path.join(__dirname, '../src/tools/coding-agents/pipeline.ts'), 'utf-8');
        const call = src.slice(src.indexOf('result.verification.repairBrief = buildRepairBrief({'), src.indexOf('result.verification.repairBrief = buildRepairBrief({') + 1200);
        expect(call).toMatch(/baselineFailedCases:\s*informativeBaseline\(verifyBaseline\)/);
        expect(call).toMatch(/missingExports:\s*exportGaps\(activeGoal,/);
        expect(call).not.toMatch(/baselineFailedCases:\s*verifyBaseline\.failedCases/);
    });
});

describe('#117: a suite that failed to load is not a list of cases', () => {
    const load = async () => (await import('../src/tools/coding-agents/verify-guard.js')) as { informativeBaseline?: (b: { ok: boolean; failedCases: string[] }) => string[] | undefined };

    it('a baseline whose only entry names the test file (the module did not load) says nothing', async () => {
        const f = (await load()).informativeBaseline!;
        expect(f({ ok: false, failedCases: ['tests/reverse-sanitize.test.ts [ tests/reverse-sanitize.test.ts ]'] })).toBeUndefined();
        expect(f({ ok: false, failedCases: ['tests/a.spec.ts'] })).toBeUndefined();
    });
    it('real case names are kept, and file-level entries are dropped from a mixed list', async () => {
        const f = (await load()).informativeBaseline!;
        expect(f({ ok: false, failedCases: ['tests/a.test.ts [ tests/a.test.ts ]', 'does the thing 4ms'] })).toEqual(['does the thing 4ms']);
        expect(f({ ok: false, failedCases: ['tests/a.test.ts > suite > case'] })).toEqual(['tests/a.test.ts > suite > case']);
    });
});
