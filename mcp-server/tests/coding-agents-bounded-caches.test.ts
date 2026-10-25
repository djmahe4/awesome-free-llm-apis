import { describe, it, expect } from 'vitest';
import { BoundedMap, codingAgentsResultsCache, sessionAliases } from '../src/tools/coding-agents/session-wiring.js';

// Audit P4: the result cache (full patched file contents per run) and the session-alias map were never
// evicted, so a long-running dashboard grew without bound.

describe('BoundedMap', () => {
    it('evicts the least recently set entry past its limit', () => {
        const m = new BoundedMap<string, number>(2);
        m.set('a', 1); m.set('b', 2); m.set('c', 3);
        expect([...m.keys()]).toEqual(['b', 'c']);
    });

    it('setting an existing key refreshes it instead of evicting it', () => {
        const m = new BoundedMap<string, number>(2);
        m.set('a', 1); m.set('b', 2); m.set('a', 10); m.set('c', 3);
        expect([...m.keys()]).toEqual(['a', 'c']);
        expect(m.get('a')).toBe(10);
    });

    it('is still a Map for callers', () => {
        expect(new BoundedMap(1)).toBeInstanceOf(Map);
    });
});

describe('coding_agents caches are bounded', () => {
    it('the result cache and the alias map are BoundedMaps', () => {
        expect(codingAgentsResultsCache).toBeInstanceOf(BoundedMap);
        expect(sessionAliases).toBeInstanceOf(BoundedMap);
        expect((codingAgentsResultsCache as BoundedMap<string, unknown>).limit).toBeGreaterThan(0);
    });
});
