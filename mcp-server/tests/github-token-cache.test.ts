import { describe, it, expect, afterEach } from 'vitest';
import { GithubRepoClient } from '../src/utils/GithubRepoClient.js';
import { httpGetJson } from '../src/utils/http.js';
import { failFromHttp } from '../src/utils/grounding.js';
import { mockFetch, type MockRoute } from './helpers/mock-fetch.js';

// C12: unauthenticated GitHub allows 60 requests/hour and one lookup costs ~12, there was no token support, a
// 403 rate limit was recognised in one place only, every lookup refetched, and a response body had no size cap.

const META = { full_name: 'o/r', default_branch: 'main', html_url: 'https://github.com/o/r', stargazers_count: 1 };
const routes = (extra: MockRoute[] = []): MockRoute[] => [
    ...extra,
    { match: '/git/trees/', body: { tree: [{ type: 'blob', path: 'README.md' }] } },
    { match: 'raw.githubusercontent.com', body: '# readme' },
    { match: 'api.github.com/repos/o/r', body: META },
];
const base = (m: ReturnType<typeof mockFetch>) => ({ fetchImpl: m.fetchImpl, sleep: async () => {}, retries: 0 });

afterEach(() => { delete process.env.GITHUB_TOKEN; delete process.env.GH_TOKEN; });

describe('GITHUB_TOKEN', () => {
    it('is sent to the GitHub hosts only, as a bearer token', async () => {
        process.env.GITHUB_TOKEN = 'ghp_secret123';
        const m = mockFetch(routes());
        await new GithubRepoClient(base(m)).understand('o', 'r');
        const seen = m.requests.map(r => ({ host: new URL(r.url).host, auth: r.headers.Authorization }));
        expect(seen.length).toBeGreaterThan(2);
        for (const a of seen) {
            expect(['api.github.com', 'raw.githubusercontent.com']).toContain(a.host);
            expect(a.auth).toBe('Bearer ghp_secret123');
        }
    });

    it('is absent when not configured, and GH_TOKEN works too', async () => {
        const m1 = mockFetch(routes());
        await new GithubRepoClient(base(m1)).getMeta('o', 'r');
        expect(m1.requests.every(r => r.headers.Authorization === undefined)).toBe(true);
        process.env.GH_TOKEN = 'gho_other';
        const m2 = mockFetch(routes());
        await new GithubRepoClient(base(m2)).getMeta('o', 'r');
        expect(m2.requests[0].headers.Authorization).toBe('Bearer gho_other');
    });

    it('never appears in a result, even a failing one', async () => {
        process.env.GITHUB_TOKEN = 'ghp_secret123';
        const m = mockFetch([{ match: 'api.github.com', status: 500, body: 'boom' }]);
        const r = await new GithubRepoClient(base(m)).getMeta('o', 'r');
        expect(JSON.stringify(r)).not.toContain('ghp_secret123');
    });
});

describe('rate limits', () => {
    it('failFromHttp recognises a 403 rate limit by the remaining header or the message', () => {
        const res = (over: any) => ({ url: 'https://api.github.com/x', status: 403, ok: false, attempts: 1, ...over });
        expect(failFromHttp(res({ rateLimit: { remaining: 0 } }), 'GitHub o/r')).toMatchObject({ found: false, reason: 'rate_limited' });
        expect(failFromHttp(res({ json: { message: 'API rate limit exceeded for 1.2.3.4' } }), 'GitHub o/r')).toMatchObject({ reason: 'rate_limited' });
        expect(failFromHttp(res({ json: { message: 'Resource not accessible' } }), 'GitHub o/r')).toMatchObject({ reason: 'unexpected_response' });
    });

    it('a quota hit on the file tree is named as such, not as a missing tree', async () => {
        const m = mockFetch(routes([{ match: '/git/trees/', status: 403, headers: { 'x-ratelimit-remaining': '0' }, body: { message: 'API rate limit exceeded' } }]));
        const r: any = await new GithubRepoClient(base(m)).understand('o', 'r');
        expect(r.found).toBe(true);
        expect(r.data.notes.join(' ')).toMatch(/quota|rate limit/i);
    });

    it('a secondary-limit 403 with a short Retry-After is retried', async () => {
        const m = mockFetch([{ match: 'x', sequence: [{ status: 403, headers: { 'retry-after': '1' }, body: { message: 'secondary rate limit' } }, { status: 200, body: { ok: true } }] }]);
        const r = await httpGetJson('https://api.github.com/x', { fetchImpl: m.fetchImpl, sleep: async () => {}, retries: 2 });
        expect(r.ok).toBe(true);
        expect(r.attempts).toBe(2);
    });

    it('a 403 that is not a rate limit is not retried', async () => {
        const m = mockFetch([{ match: 'x', status: 403, body: { message: 'Forbidden' } }]);
        const r = await httpGetJson('https://api.github.com/x', { fetchImpl: m.fetchImpl, sleep: async () => {}, retries: 2 });
        expect(r.attempts).toBe(1);
    });
});

describe('cache', () => {
    it('a repeated lookup within the TTL does not refetch; after it, it does', async () => {
        let t = 1_000_000;
        const m = mockFetch(routes());
        const c = new GithubRepoClient({ ...base(m), now: () => t, cache: true });
        await c.understand('o', 'r');
        const first = m.calls.length;
        await c.understand('o', 'r');
        expect(m.calls.length).toBe(first);
        t += 6 * 60_000;
        await c.understand('o', 'r');
        expect(m.calls.length).toBe(first * 2);
    });

    it('failed responses are not cached', async () => {
        const m = mockFetch([{ match: 'api.github.com/repos/o/r', sequence: [{ status: 500, body: 'x' }, { status: 200, body: META }] }, ...routes()]);
        const c = new GithubRepoClient({ ...base(m), cache: true });
        expect((await c.getMeta('o', 'r')).found).toBe(false);
        expect((await c.getMeta('o', 'r')).found).toBe(true);
    });

    it('is off for an injected fetch unless asked for (existing tests keep their own call counts)', async () => {
        const m = mockFetch(routes());
        const c = new GithubRepoClient(base(m));
        await c.getMeta('o', 'r');
        await c.getMeta('o', 'r');
        expect(m.callsMatching('api.github.com/repos/o/r').length).toBe(2);
    });
});

describe('response size cap', () => {
    it('a large but reasonable JSON body is parsed in full (a big repo file tree is several MB)', async () => {
        const body = '{"a":"' + 'x'.repeat(6 * 1024 * 1024) + '"}';
        const m = mockFetch([{ match: 'x', body }]);
        const r = await httpGetJson('https://api.github.com/x', { fetchImpl: m.fetchImpl, sleep: async () => {}, retries: 0 });
        expect(r.ok).toBe(true);
        expect((r.json as any).a.length).toBe(6 * 1024 * 1024);
    });

    it('a body over the parse ceiling (HTTP_MAX_JSON_BYTES, default 25 MB) is refused and says so', async () => {
        process.env.HTTP_MAX_JSON_BYTES = '100000';
        try {
            const m = mockFetch([{ match: 'x', body: '{"a":"' + 'x'.repeat(150_000) + '"}' }]);
            const r = await httpGetJson('https://api.github.com/x', { fetchImpl: m.fetchImpl, sleep: async () => {}, retries: 0 });
            expect(r.json).toBeUndefined();
            expect(r.ok).toBe(false);
            expect(r.error).toMatch(/too large.*HTTP_MAX_JSON_BYTES/i);
        } finally {
            delete process.env.HTTP_MAX_JSON_BYTES;
        }
    });
});
