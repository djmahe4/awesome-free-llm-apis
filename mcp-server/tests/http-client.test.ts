import { describe, it, expect } from 'vitest';
import { httpGetJson, parseRateLimit } from '../src/utils/http.js';
import { mockFetch } from './helpers/mock-fetch.js';

const noSleep = () => {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => { waits.push(ms); } };
};

describe('parseRateLimit', () => {
  const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });

  it('reads Docker Hub X-RateLimit-* (epoch reset)', () => {
    expect(parseRateLimit(h({ 'x-ratelimit-limit': '180', 'x-ratelimit-remaining': '179', 'x-ratelimit-reset': '1792509948' }), 0))
      .toEqual({ limit: 180, remaining: 179, resetAtEpochS: 1792509948 });
  });

  it('reads GitLab/IETF RateLimit-* and converts a relative reset to an epoch', () => {
    const r = parseRateLimit(h({ 'ratelimit-limit': '500', 'ratelimit-remaining': '498', 'ratelimit-reset': '30' }), 1_000_000);
    expect(r).toEqual({ limit: 500, remaining: 498, resetAtEpochS: 1000 + 30 });
  });

  it('returns undefined when no rate-limit headers are present', () => {
    expect(parseRateLimit(h({}), 0)).toBeUndefined();
  });
});

describe('httpGetJson', () => {
  it('parses JSON and surfaces rate-limit info', async () => {
    const m = mockFetch([{ match: '/ok', body: { a: 1 }, headers: { 'X-RateLimit-Remaining': '5' } }]);
    const r = await httpGetJson('https://x.test/ok', { fetchImpl: m.fetchImpl });
    expect(r).toMatchObject({ ok: true, status: 200, json: { a: 1 }, attempts: 1, rateLimit: { remaining: 5 } });
  });

  it('does not retry a 404 and reports it', async () => {
    const m = mockFetch([{ match: '/missing', status: 404, body: { message: 'nope' } }]);
    const { sleep, waits } = noSleep();
    const r = await httpGetJson('https://x.test/missing', { fetchImpl: m.fetchImpl, sleep });
    expect(r.status).toBe(404);
    expect(r.ok).toBe(false);
    expect(m.calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('retries 5xx with exponential backoff and returns the eventual success', async () => {
    const m = mockFetch([{ match: '/flaky', sequence: [{ status: 503 }, { status: 502 }, { status: 200, body: { done: true } }] }]);
    const { sleep, waits } = noSleep();
    const r = await httpGetJson('https://x.test/flaky', { fetchImpl: m.fetchImpl, sleep, backoffMs: 100, retries: 2 });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
    expect(waits).toEqual([100, 200]);
  });

  it('gives up after retries+1 attempts on persistent 5xx and returns the last failure', async () => {
    const m = mockFetch([{ match: '/down', status: 500 }]);
    const { sleep } = noSleep();
    const r = await httpGetJson('https://x.test/down', { fetchImpl: m.fetchImpl, sleep, retries: 1 });
    expect(r.status).toBe(500);
    expect(m.calls).toHaveLength(2);
  });

  it('honours Retry-After on 429 when it fits inside maxWaitMs, then succeeds', async () => {
    const m = mockFetch([{ match: '/limited', sequence: [{ status: 429, headers: { 'Retry-After': '2' } }, { status: 200, body: { ok: 1 } }] }]);
    const { sleep, waits } = noSleep();
    const r = await httpGetJson('https://x.test/limited', { fetchImpl: m.fetchImpl, sleep, maxWaitMs: 10_000 });
    expect(r.ok).toBe(true);
    expect(waits).toEqual([2000]);
  });

  it('does NOT sit through a 429 whose wait exceeds maxWaitMs — surfaces retryAfterMs instead', async () => {
    const m = mockFetch([{ match: '/limited', status: 429, headers: { 'Retry-After': '120' } }]);
    const { sleep, waits } = noSleep();
    const r = await httpGetJson('https://x.test/limited', { fetchImpl: m.fetchImpl, sleep, maxWaitMs: 5_000 });
    expect(r.status).toBe(429);
    expect(r.retryAfterMs).toBe(120_000);
    expect(m.calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('uses X-RateLimit-Reset to size a 429 wait when Retry-After is absent', async () => {
    const now = 1_000_000_000_000; // ms
    const resetEpochS = now / 1000 + 3;
    const m = mockFetch([{ match: '/limited', sequence: [{ status: 429, headers: { 'X-RateLimit-Reset': String(resetEpochS) } }, { status: 200, body: {} }] }]);
    const { sleep, waits } = noSleep();
    const r = await httpGetJson('https://x.test/limited', { fetchImpl: m.fetchImpl, sleep, now: () => now });
    expect(r.ok).toBe(true);
    expect(waits).toEqual([3000]);
  });

  it('reports network failure as status 0 with a readable error (never throws)', async () => {
    const m = mockFetch([{ match: '/x', throws: { message: 'connect ECONNREFUSED', code: 'ECONNREFUSED' } }]);
    const { sleep } = noSleep();
    const r = await httpGetJson('https://x.test/x', { fetchImpl: m.fetchImpl, sleep, retries: 1 });
    expect(r.status).toBe(0);
    expect(r.error).toContain('ECONNREFUSED');
    expect(r.attempts).toBe(2);
  });

  it('describes an abort/timeout as a timeout', async () => {
    const m = mockFetch([{ match: '/slow', throws: { name: 'TimeoutError', message: 'The operation was aborted' } }]);
    const { sleep } = noSleep();
    const r = await httpGetJson('https://x.test/slow', { fetchImpl: m.fetchImpl, sleep, retries: 0, timeoutMs: 1234 });
    expect(r.error).toBe('timeout after 1234ms');
  });

  it('keeps a snippet of a non-JSON body and leaves json undefined', async () => {
    const m = mockFetch([{ match: '/html', body: '<html>blocked</html>' }]);
    const r = await httpGetJson('https://x.test/html', { fetchImpl: m.fetchImpl });
    expect(r.json).toBeUndefined();
    expect(r.textSnippet).toContain('blocked');
  });
});
