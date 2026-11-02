import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkWorkOrder } from '../src/tools/coding-agents/work-order-decision.js';

// #150: no model decides this by default. The rule switches model and never stops a run.

const GOAL = 'In a.ts replace the line `return text;` with `return clean(text);`.';
const INPUT = { goal: GOAL, patchPlan: [{ fullPatchedContent: 'x' }], brief: 'b', cloudAllowed: true, preferCloud: false };

describe('triage default', () => {
    afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

    it('uses the rule and calls no model unless a triage model is set', async () => {
        vi.stubEnv('CODING_AGENTS_TRIAGE_MODEL', '');
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const r = await checkWorkOrder(INPUT);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(r.action).toBe('reroute');
        expect(r.preferCloud).toBe(true);
    });
    it('asks the model when one is set', async () => {
        vi.stubEnv('CODING_AGENTS_TRIAGE_MODEL', 'some-model');
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ response: '{"cause":"wrong_place","action":"retry"}' })));
        vi.stubGlobal('fetch', fetchMock);
        const r = await checkWorkOrder(INPUT);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(r.action).toBe('retry');
    });
});
