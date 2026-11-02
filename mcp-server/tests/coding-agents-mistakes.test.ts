import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyMistake, recordMistake, remediationsFor, loadMistakes } from '../src/tools/coding-agents/mistakes.js';
import { runWithRepairLoop } from '../src/tools/coding-agents/repair-loop.js';
import type { CodingAgentsInput, CodingAgentsResult } from '../src/tools/coding-agents/types.js';

// #149: the same mistakes repeat across runs because nothing records them.

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-mistakes-')); });
afterEach(() => fs.rm(root, { recursive: true, force: true }));

const DAY = 86_400_000;

describe('classifyMistake', () => {
    it('names the kind of failure from facts', () => {
        expect(classifyMistake({ outcome: 'not_converged', symbolLoss: ['a'] })).toBe('symbol_loss');
        expect(classifyMistake({ outcome: 'cycling' })).toBe('cycling');
        expect(classifyMistake({ outcome: 'timed_out' })).toBe('timed_out');
        expect(classifyMistake({ outcome: 'stuck' })).toBe('stuck');
        expect(classifyMistake({ outcome: 'not_converged' })).toBe('not_converged');
    });
    it('is undefined for a run that finished', () => {
        expect(classifyMistake({ outcome: 'converged' })).toBeUndefined();
        expect(classifyMistake({ outcome: 'unverified' })).toBeUndefined();
        expect(classifyMistake({ outcome: 'aborted' })).toBeUndefined();
        expect(classifyMistake({ outcome: 'needs_user' })).toBeUndefined();
    });
});

describe('the store', () => {
    it('counts the same mistake on the same file and keeps first and last seen', async () => {
        await recordMistake(root, 'cycling', ['a.ts'], 1000);
        await recordMistake(root, 'cycling', ['a.ts'], 2000);
        await recordMistake(root, 'cycling', ['b.ts'], 3000);
        const store = await loadMistakes(root);
        const a = store.find(m => m.file === 'a.ts');
        expect(a).toMatchObject({ kind: 'cycling', count: 2, firstSeen: 1000, lastSeen: 2000 });
        expect(typeof a?.remediation).toBe('string');
        expect(store).toHaveLength(2);
    });
    it('writes it under .free-llm-mcp/mistakes.json', async () => {
        await recordMistake(root, 'cycling', ['a.ts']);
        expect(JSON.parse(await fs.readFile(path.join(root, '.free-llm-mcp', 'mistakes.json'), 'utf8'))).toHaveLength(1);
    });
    it('a corrupt or missing file reads as empty', async () => {
        expect(await loadMistakes(root)).toEqual([]);
        await fs.mkdir(path.join(root, '.free-llm-mcp'), { recursive: true });
        await fs.writeFile(path.join(root, '.free-llm-mcp', 'mistakes.json'), '{not json');
        expect(await loadMistakes(root)).toEqual([]);
    });
});

describe('remediationsFor', () => {
    it('returns only those for the target files, once each, most frequent first, at most three', async () => {
        const now = 100 * DAY;
        for (let i = 0; i < 3; i++) await recordMistake(root, 'symbol_loss', ['a.ts'], now);
        await recordMistake(root, 'cycling', ['a.ts'], now);
        await recordMistake(root, 'timed_out', ['other.ts'], now);
        const lines = await remediationsFor(root, ['a.ts'], now);
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatch(/declaration/i);
    });
    it('drops an entry not seen for thirty days', async () => {
        await recordMistake(root, 'cycling', ['a.ts'], 0);
        expect(await remediationsFor(root, ['a.ts'], 31 * DAY)).toEqual([]);
    });
});

describe('the repair loop', () => {
    const red: CodingAgentsResult = {
        sessionId: 's', goal: 'g', pipelineStage: 'completed', relevantFiles: [], anchors: [], patchPlan: [], patchSummary: '', diagnostics: [], applied: true, status: 'applied',
        verification: { command: 'c', status: 'not_green', ok: false, baselineOk: false, exitCode: 1, timedOut: false, outputTail: '', durationMs: 1, failedCases: ['t'], repairBrief: 'red' },
    } as unknown as CodingAgentsResult;
    const input = (): CodingAgentsInput => ({ goal: 'Make it faster.', dryRun: false, verifyCommand: 'node t.js', resolve: { action: 'apply' }, maxRepairAttempts: 0, samples: 1, workspaceRoot: root, targetFiles: ['a.ts'] });

    it('records a failed run, and the next run on that file starts with the remediation', async () => {
        await runWithRepairLoop(input(), 's', undefined, async () => red, async () => []);
        const store = await loadMistakes(root);
        expect(store[0]).toMatchObject({ kind: 'not_converged', file: 'a.ts', count: 1 });
        const seen: CodingAgentsInput[] = [];
        await runWithRepairLoop(input(), 's', undefined, async i => { seen.push(i); return red; }, async () => []);
        expect(String(seen[0].feedback)).toContain(store[0].remediation);
        expect((await loadMistakes(root))[0].count).toBe(2);
    });
    it('a run without a workspace records nothing and does not fail', async () => {
        const { workspaceRoot, ...rest } = input();
        await expect(runWithRepairLoop(rest as CodingAgentsInput, 's', undefined, async () => red, async () => [])).resolves.toBeDefined();
    });
});
