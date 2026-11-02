import { describe, it, expect, vi } from 'vitest';
import { checkWorkOrder, unfinishedBrief } from '../src/tools/coding-agents/work-order-decision.js';

const NEW_A = 'const withoutAnsi = strip(text);';
const NEW_B = 'return clean(withoutAnsi);';
const GOAL = `In a.ts replace the line \`return text;\` with these two lines: line 1 \`${NEW_A}\` and line 2 \`${NEW_B}\`. Change nothing else.`;
const plan = (content: string) => [{ filePath: 'a.ts', fullPatchedContent: content }] as any[];
const answer = (action: 'retry' | 'reroute' | 'stop') => vi.fn(async () => ({ cause: 'not_copied' as const, action, source: 'local' as const }));

describe('checkWorkOrder', () => {
    it('returns nothing to do when the supplied text is in the edit', async () => {
        const triage = answer('reroute');
        const r = await checkWorkOrder({ goal: GOAL, patchPlan: plan(`${NEW_A}\n${NEW_B}`), brief: 'b', cloudAllowed: true, preferCloud: false }, triage);
        expect(r).toEqual({ brief: 'b' });
        expect(triage).not.toHaveBeenCalled();
    });
    it('returns nothing to do when the edit has no file content', async () => {
        const triage = answer('reroute');
        const r = await checkWorkOrder({ goal: GOAL, patchPlan: [], brief: 'b', cloudAllowed: true, preferCloud: false }, triage);
        expect(r).toEqual({ brief: 'b' });
        expect(triage).not.toHaveBeenCalled();
    });
    it('returns nothing to do when the goal supplies no text', async () => {
        const triage = answer('reroute');
        const r = await checkWorkOrder({ goal: 'Make it faster.', patchPlan: plan('x'), brief: 'b', cloudAllowed: true, preferCloud: false }, triage);
        expect(r).toEqual({ brief: 'b' });
    });
    it('puts the missing text before the brief and passes the facts to triage', async () => {
        const triage = answer('retry');
        const r = await checkWorkOrder({ goal: GOAL, patchPlan: plan('return wrong;'), brief: 'expected a got b', cloudAllowed: false, preferCloud: false }, triage);
        expect(r.brief.startsWith('The goal supplied')).toBe(true);
        expect(r.brief).toContain(NEW_A);
        expect(r.brief.endsWith('expected a got b')).toBe(true);
        expect(r.cause).toBe('not_copied');
        expect(r.action).toBe('retry');
        expect(r.preferCloud).toBeUndefined();
        expect(triage).toHaveBeenCalledWith({ goal: GOAL, missing: [NEW_A, NEW_B], brief: 'expected a got b' });
    });
    it('a reroute flips the model when the cloud is allowed', async () => {
        const toCloud = await checkWorkOrder({ goal: GOAL, patchPlan: plan('x'), brief: 'b', cloudAllowed: true, preferCloud: false }, answer('reroute'));
        expect(toCloud.preferCloud).toBe(true);
        const toLocal = await checkWorkOrder({ goal: GOAL, patchPlan: plan('x'), brief: 'b', cloudAllowed: true, preferCloud: true }, answer('reroute'));
        expect(toLocal.preferCloud).toBe(false);
    });
    it('a reroute changes nothing when the cloud is not allowed', async () => {
        const r = await checkWorkOrder({ goal: GOAL, patchPlan: plan('x'), brief: 'b', cloudAllowed: false, preferCloud: false }, answer('reroute'));
        expect(r.preferCloud).toBeUndefined();
    });
    it('a stop is reported', async () => {
        const r = await checkWorkOrder({ goal: GOAL, patchPlan: plan('x'), brief: 'b', cloudAllowed: true, preferCloud: false }, answer('stop'));
        expect(r.action).toBe('stop');
    });
});

describe('unfinishedBrief', () => {
    it('names the text a green edit left out', () => {
        const brief = unfinishedBrief(GOAL, plan(NEW_A));
        expect(brief?.startsWith('The goal supplied')).toBe(true);
        expect(brief).toContain(NEW_B);
        expect(brief).not.toContain(NEW_A);
    });
    it('is undefined when everything landed, nothing was patched, or the goal supplied nothing', () => {
        expect(unfinishedBrief(GOAL, plan(NEW_A + NEW_B))).toBeUndefined();
        expect(unfinishedBrief(GOAL, [])).toBeUndefined();
        expect(unfinishedBrief('Make it faster.', plan('x'))).toBeUndefined();
    });
});
