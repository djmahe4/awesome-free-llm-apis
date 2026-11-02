import { describe, it, expect, vi } from 'vitest';
import { runWithRepairLoop } from '../src/tools/coding-agents/repair-loop.js';
import { checkWorkOrder } from '../src/tools/coding-agents/work-order-decision.js';
import type { CodingAgentsInput, CodingAgentsResult } from '../src/tools/coding-agents/types.js';

// The repair loop goes back to the work order: when the goal supplied exact text and the edit lacks it, the next
// brief quotes that text first, and a decision (retry, reroute, stop) steers the next attempt.

const NEW_A = 'const withoutAnsi = strip(text);';
const NEW_B = 'return clean(withoutAnsi);';
const GOAL = `In a.ts replace the line \`return text;\` with these two lines: line 1 \`${NEW_A}\` and line 2 \`${NEW_B}\`. Change nothing else.`;

describe('the repair loop goes back to the work order', () => {
    const input: CodingAgentsInput = { goal: GOAL, dryRun: false, verifyCommand: 'node t.js', resolve: { action: 'apply' }, maxRepairAttempts: 1, samples: 1 };
    const red = (content: string): CodingAgentsResult => ({
        sessionId: 's', goal: GOAL, pipelineStage: 'completed', relevantFiles: [], anchors: [], patchSummary: '', diagnostics: [],
        patchPlan: [{ filePath: 'a.ts', fullPatchedContent: content }],
        applied: true, checkpointId: 'cp1', status: 'applied',
        verification: { command: 'c', status: 'not_green', ok: false, baselineOk: false, exitCode: 1, timedOut: false, outputTail: '', durationMs: 1, failedCases: ['case'], repairBrief: 'expected a got b' },
    } as unknown as CodingAgentsResult);

    async function run(content: string, extra: Partial<CodingAgentsInput> = {}, action: 'retry' | 'reroute' | 'stop' = 'reroute') {
        const inputs: CodingAgentsInput[] = [];
        const triage = vi.fn(async () => ({ cause: 'not_copied' as const, action, source: 'local' as const }));
        const r = await runWithRepairLoop({ ...input, ...extra }, 's', undefined, async i => { inputs.push(i); return red(content); }, async () => [], undefined, (input: any) => checkWorkOrder(input, triage));
        return { r, inputs, triage };
    }

    it('puts the missing text at the front of the next brief and records the cause', async () => {
        const { r, inputs, triage } = await run('return wrong;');
        expect(triage).toHaveBeenCalled();
        const feedback = String(inputs[1].feedback);
        expect(feedback.startsWith('The goal supplied')).toBe(true);
        expect(feedback).toContain(NEW_A);
        expect(feedback).toContain('expected a got b');
        expect(r.repair?.attempts[0]).toMatchObject({ triage: 'not_copied' });
    });
    it('reroutes the next attempt away from the local model when the cloud is allowed', async () => {
        const { inputs } = await run('return wrong;', { allowCloudFallback: true });
        expect(inputs[1].preferCloud).toBe(true);
    });
    it('reroutes the next attempt away from the cloud model to the local one', async () => {
        const { inputs } = await run('return wrong;', { allowCloudFallback: true, preferCloud: true });
        expect(inputs[1].preferCloud).toBe(false);
    });
    it('a retry decision keeps the same model', async () => {
        const { inputs } = await run('return wrong;', { allowCloudFallback: true }, 'retry');
        expect(inputs[1].preferCloud).toBeUndefined();
    });
    it('a stop decision ends the loop without another attempt', async () => {
        const { r, inputs } = await run('return wrong;', { allowCloudFallback: true }, 'stop');
        expect(inputs).toHaveLength(1);
        expect(r.repair?.outcome).toBe('stuck');
    });
    it('stays out of the way when the supplied text is there', async () => {
        const { inputs, triage } = await run(`${NEW_A}\n${NEW_B}`, { allowCloudFallback: true });
        expect(triage).not.toHaveBeenCalled();
        expect(String(inputs[1].feedback).startsWith('The goal supplied')).toBe(false);
        expect(inputs[1].preferCloud).toBeUndefined();
    });
});
