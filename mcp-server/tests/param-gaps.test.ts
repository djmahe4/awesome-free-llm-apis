import { describe, it, expect } from 'vitest';
import { computeGaps, findNewGaps, findClosedGaps } from '../scripts/verification/param-gaps.js';

describe('parameter-gap ratchet', () => {
    const schema = { t: ['a', 'b', 'c'] };
    it('computes what the frontend does not show', () => {
        expect(computeGaps(schema, { t: ['a'] }, { t: ['a', 'b', 'c'] }, ['t'])).toEqual({ t: { playground: ['b', 'c'], quickstart: [] } });
        expect(computeGaps(schema, { t: ['a', 'b', 'c'] }, { t: ['a', 'b', 'c'] }, ['t'])).toEqual({});
    });
    it('a gap already in the baseline is tolerated, a new one is reported', () => {
        const baseline = { t: { playground: ['b'], quickstart: [] } };
        expect(findNewGaps({ t: { playground: ['b'], quickstart: [] } }, baseline)).toEqual([]);
        expect(findNewGaps({ t: { playground: ['b', 'c'], quickstart: ['a'] } }, baseline)).toEqual([
            '[t] playground does not show: c',
            '[t] quickstart does not show: a',
        ]);
    });
    it('a brand-new tool with gaps is reported in full', () => {
        expect(findNewGaps({ u: { playground: ['x'], quickstart: [] } }, {})).toEqual(['[u] playground does not show: x']);
    });
    it('reports gaps that were closed so the baseline can shrink', () => {
        expect(findClosedGaps({}, { t: { playground: ['b'], quickstart: [] } })).toEqual(['[t] playground: b']);
        expect(findClosedGaps({ t: { playground: ['b'], quickstart: [] } }, { t: { playground: ['b'], quickstart: [] } })).toEqual([]);
    });
});
