import { describe, it, expect, vi, afterEach } from 'vitest';
import { lookupDnsRecords } from '../src/utils/dns-report.js';
import { osintResultsCache } from '../src/tools/cyber-tool.js';
import { BoundedMap } from '../src/utils/bounded-map.js';

// C11: the five DNS lookups ran one after another (a dead resolver cost 5 x 3 s), their timeout timers were
// never cleared, and osintResultsCache grew without bound.

afterEach(() => vi.useRealTimers());

const delayed = <T>(value: T, ms: number) => () => new Promise<T>(r => setTimeout(() => r(value), ms));
const resolvers = (ms = 100) => ({
    resolve4: delayed(['1.2.3.4'], ms),
    resolve6: delayed(['::1'], ms),
    resolveMx: delayed([{ exchange: 'mx.example.com', priority: 10 }], ms),
    resolveTxt: delayed([['v=spf1 -all']], ms),
    resolveNs: delayed(['ns1.example.com'], ms),
});

describe('lookupDnsRecords', () => {
    it('runs the lookups in parallel', async () => {
        const started = Date.now();
        const { report, resolvedIps } = await lookupDnsRecords('example.com', resolvers(120), 3000);
        expect(Date.now() - started).toBeLessThan(450); // sequential would be 5 x 120 ms
        expect(report).toMatchObject({ A: ['1.2.3.4'], AAAA: ['::1'], NS: ['ns1.example.com'] });
        expect(report.MX).toHaveLength(1);
        expect(report.TXT).toHaveLength(1);
        expect(resolvedIps).toEqual(['1.2.3.4', '::1']);
    });

    it('a slow or failing resolver is cut at the timeout and does not affect the others', async () => {
        const r = {
            ...resolvers(10),
            resolveMx: () => new Promise<never>(() => {}), // never answers
            resolveTxt: () => Promise.reject(new Error('SERVFAIL')),
        };
        const started = Date.now();
        const { report } = await lookupDnsRecords('example.com', r, 150);
        expect(Date.now() - started).toBeLessThan(1500);
        expect(report.A).toEqual(['1.2.3.4']);
        expect(report.MX).toBeUndefined();
        expect(report.TXT).toBeUndefined();
    });

    it('leaves no timer behind when the lookups answer in time', async () => {
        vi.useFakeTimers();
        const p = lookupDnsRecords('example.com', {
            resolve4: async () => ['1.2.3.4'], resolve6: async () => [], resolveMx: async () => [], resolveTxt: async () => [], resolveNs: async () => [],
        }, 3000);
        await vi.advanceTimersByTimeAsync(0);
        await p;
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('osintResultsCache', () => {
    it('is bounded', () => {
        expect(osintResultsCache).toBeInstanceOf(BoundedMap);
        expect((osintResultsCache as BoundedMap<string, unknown>).limit).toBeGreaterThan(0);
        expect((osintResultsCache as BoundedMap<string, unknown>).limit).toBeLessThanOrEqual(500);
    });
});
