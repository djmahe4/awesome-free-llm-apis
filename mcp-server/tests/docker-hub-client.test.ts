import { describe, it, expect } from 'vitest';
import { DockerHubClient, rankCandidates, splitRepoName, type DockerRepoSummary } from '../src/utils/DockerHubClient.js';
import { buildToolProfile } from '../src/utils/groundingEvidence.js';
import { mockFetch, type MockRoute } from './helpers/mock-fetch.js';

const client = (routes: MockRoute[]) => {
  const m = mockFetch(routes);
  return { m, c: new DockerHubClient({ fetchImpl: m.fetchImpl, sleep: async () => {}, retries: 0 }) };
};

// Shapes copied from live responses.
const searchItem = (repo_name: string, pull_count = 1000, extra: Record<string, unknown> = {}) =>
  ({ repo_name, short_description: `desc of ${repo_name}`, star_count: 3, pull_count, repo_owner: '', is_automated: false, is_official: false, ...extra });
const repoBody = (namespace: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ user: namespace, name, namespace, description: `d ${name}`, star_count: 5, pull_count: 99, last_updated: '2026-10-01T00:00:00Z', full_description: `# ${name}\nreadme text`, categories: [{ name: 'Networking', slug: 'networking' }], storage_size: 123, ...extra });

// Real Hub text for the images discussed in the PR.
const NMAP_DESC = 'Nmap ("Network Mapper") Docker Image';
const ORY_DESC = 'Scalable, security first OAuth 2.0 and OpenID Connect server';
const ORY_FULL = 'Please check out the [ORY Hydra Documentation](https://www.ory.com/hydra/docs/) for more information and details about using this image.';

const nmap = buildToolProfile('nmap', 'https://github.com/nmap/nmap');
const hydra = buildToolProfile('hydra', 'https://github.com/vanhauser-thc/thc-hydra');

describe('splitRepoName', () => {
  it('maps a bare name to the official library namespace', () => {
    expect(splitRepoName('ubuntu')).toEqual({ namespace: 'library', repo: 'ubuntu' });
    expect(splitRepoName('instrumentisto/nmap')).toEqual({ namespace: 'instrumentisto', repo: 'nmap' });
  });
});

describe('DockerHubClient.search', () => {
  it('maps results, treats bare names as official, and builds grounded pull commands and URLs', async () => {
    const { c, m } = client([{ match: '/v2/search/repositories/', body: { count: 2344, next: 'x', results: [searchItem('instrumentisto/nmap', 5000), searchItem('ubuntu', 9, { is_official: true })] } }]);
    const r = await c.search('nmap', { pageSize: 5 });
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.data.total).toBe(2344);
    expect(r.data.hasMore).toBe(true);
    expect(r.data.results[0]).toMatchObject({ fullName: 'instrumentisto/nmap', isOfficial: false, pullCommand: 'docker pull instrumentisto/nmap', url: 'https://hub.docker.com/r/instrumentisto/nmap' });
    expect(r.data.results[1]).toMatchObject({ fullName: 'ubuntu', namespace: 'library', isOfficial: true, pullCommand: 'docker pull ubuntu', url: 'https://hub.docker.com/_/ubuntu' });
    expect(m.calls[0]).toContain('query=nmap');
    expect(m.calls[0]).toContain('page_size=5');
  });

  it('clamps page_size to Hub\'s 1..100 and rejects empty/oversized queries without a request', async () => {
    const { c, m } = client([{ match: '/v2/search/', body: { results: [] } }]);
    await c.search('x', { pageSize: 9999 });
    expect(m.calls[0]).toContain('page_size=100');
    const before = m.calls.length;
    for (const q of ['', '   ', 'a'.repeat(101)]) {
      expect(await c.search(q)).toMatchObject({ found: false, reason: 'invalid_input' });
    }
    expect(m.calls.length).toBe(before);
  });

  it('survives missing optional fields (the search endpoint is undocumented, so parsing is tolerant)', async () => {
    const { c } = client([{ match: '/v2/search/', body: { results: [{ repo_name: 'a/b' }, { nonsense: true }] } }]);
    const r = await c.search('b');
    expect(r.found).toBe(true);
    if (r.found) { expect(r.data.results).toHaveLength(1); expect(r.data.results[0]).toMatchObject({ description: '', stars: 0, pulls: 0 }); }
  });

  it('flags an unexpected body shape rather than guessing', async () => {
    const { c } = client([{ match: '/v2/search/', body: { surprise: 1 } }]);
    expect(await c.search('nmap')).toMatchObject({ found: false, reason: 'unexpected_response' });
  });
});

describe('DockerHubClient.getRepository', () => {
  it('returns detail including the README excerpt, categories and last update', async () => {
    const { c, m } = client([{ match: '/v2/namespaces/instrumentisto/repositories/nmap', body: repoBody('instrumentisto', 'nmap') }]);
    const r = await c.getRepository('instrumentisto', 'nmap');
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.data).toMatchObject({ fullName: 'instrumentisto/nmap', categories: ['Networking'], lastUpdated: '2026-10-01T00:00:00Z', storageBytes: 123 });
    expect(r.data.aboutExcerpt).toContain('readme text');
    expect(m.calls[0]).toBe('https://hub.docker.com/v2/namespaces/instrumentisto/repositories/nmap');
  });

  it('maps 404 to a definitive not_found', async () => {
    const { c } = client([{ match: '/repositories/zzz', status: 404, body: { message: 'object not found' } }]);
    expect(await c.getRepository('library', 'zzz')).toMatchObject({ found: false, reason: 'not_found' });
  });

  it('rejects names that could escape the path, with NO network call', async () => {
    const { c, m } = client([{ match: '', body: {} }]);
    for (const [ns, repo] of [['..', 'x'], ['a/b', 'c'], ['library', '../etc/passwd'], ['LIB', 'x'], ['library', '']]) {
      expect(await c.getRepository(ns, repo)).toMatchObject({ found: false, reason: 'invalid_input' });
    }
    expect(m.calls).toHaveLength(0);
  });

  it('surfaces a 429 as rate_limited (not as "absent") with the server-requested wait', async () => {
    const { c } = client([{ match: '/repositories/', status: 429, headers: { 'Retry-After': '60' } }]);
    expect(await c.getRepository('library', 'ubuntu')).toMatchObject({ found: false, reason: 'rate_limited', retryAfterMs: 60_000 });
  });
});

describe('DockerHubClient.listTags', () => {
  it('lists tags with deduplicated platforms and skips attestation "unknown" manifests', async () => {
    const { c, m } = client([{ match: '/tags', body: { count: 286, next: 'p2', results: [
      { name: 'latest', last_updated: '2026-10-01T00:00:00Z', full_size: 1000, digest: 'sha256:abc', images: [
        { architecture: 'amd64', os: 'linux' }, { architecture: 'arm64', os: 'linux', variant: 'v8' },
        { architecture: 'amd64', os: 'linux' }, { architecture: 'unknown', os: 'unknown' } ] },
    ] } }]);
    const r = await c.listTags('instrumentisto', 'nmap', { pageSize: 1 });
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.data).toMatchObject({ total: 286, hasMore: true });
    expect(r.data.tags[0]).toMatchObject({ name: 'latest', digest: 'sha256:abc', sizeBytes: 1000, platforms: ['linux/amd64', 'linux/arm64/v8'] });
    expect(m.calls[0]).toContain('/v2/namespaces/instrumentisto/repositories/nmap/tags?page=1&page_size=1');
  });
});

describe('rankCandidates', () => {
  const s = (fullName: string, pulls: number, isOfficial = false): DockerRepoSummary => {
    const { namespace, repo } = splitRepoName(fullName);
    return { fullName, namespace, repo, description: '', stars: 0, pulls, isOfficial, isAutomated: false, pullCommand: '', url: '' };
  };

  it('puts official first, then exact-name by popularity, then contains-name; drops unrelated images', () => {
    const ranked = rankCandidates('nmap', [
      s('someone/nmap-ui', 9_999_999), s('big/nmap', 1_000_000), s('small/nmap', 10),
      s('unrelated/webserver', 50_000_000), s('nmap', 5, true),
    ]).map(r => r.fullName);
    expect(ranked).toEqual(['nmap', 'big/nmap', 'small/nmap', 'someone/nmap-ui']);
  });
});

describe('DockerHubClient.resolve — identity, not just names', () => {
  it('grounds the best image whose own text identifies the tool, with provenance', async () => {
    const { c } = client([
      { match: '/v2/namespaces/library/repositories/nmap', status: 404, body: { message: 'object not found' } },
      { match: '/v2/search/repositories/?query=nmap', body: { count: 2, results: [searchItem('parrotsec/nmap', 50), searchItem('instrumentisto/nmap', 9_000)] } },
      { match: '/v2/namespaces/instrumentisto/repositories/nmap', body: repoBody('instrumentisto', 'nmap', { description: NMAP_DESC }) },
      { match: '/v2/namespaces/parrotsec/repositories/nmap', body: repoBody('parrotsec', 'nmap', { description: 'Nmap scanner image' }) },
    ]);
    const r = await c.resolve(nmap);
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.data.best.fullName).toBe('instrumentisto/nmap');
    expect(r.data.evidence.level).toBe('domain');
    expect(r.data.best.aboutExcerpt).toContain('readme text');
    expect(r.data.alternatives.map(a => a.repo.fullName)).toEqual(['parrotsec/nmap']);
    expect(r.data.checked.some(u => u.includes('/search/repositories/'))).toBe(true);
  });

  it('REGRESSION: never presents oryd/hydra (OAuth2 server) as the registry\'s THC-Hydra, even though it is the most-pulled image named "hydra"', async () => {
    const { c } = client([
      { match: '/v2/namespaces/library/', status: 404, body: {} },
      { match: 'query=hydra', body: { count: 1, results: [searchItem('oryd/hydra', 431_000_000)] } },
      { match: 'query=thc-hydra', body: { count: 0, results: [] } },
      { match: '/v2/namespaces/oryd/repositories/hydra', body: repoBody('oryd', 'hydra', { description: ORY_DESC, full_description: ORY_FULL }) },
    ]);
    const r = await c.resolve(hydra);
    expect(r.found).toBe(false);
    if (r.found) return;
    expect(r.reason).toBe('unverified');
    expect(r.hints?.[0]).toMatchObject({ label: 'oryd/hydra', description: ORY_DESC });
    expect(r.hints?.[0].why).toContain('https://github.com/vanhauser-thc/thc-hydra');
  });

  it('prefers the image named after the registered github repo (thc-hydra) over a popular homonym', async () => {
    const { c } = client([
      { match: '/v2/namespaces/library/', status: 404, body: {} },
      { match: 'query=hydra&', body: { count: 1, results: [searchItem('oryd/hydra', 431_000_000)] } },
      { match: 'query=thc-hydra', body: { count: 1, results: [searchItem('vanhauser/thc-hydra', 100)] } },
      { match: '/v2/namespaces/oryd/repositories/hydra', body: repoBody('oryd', 'hydra', { description: ORY_DESC, full_description: ORY_FULL }) },
      { match: '/v2/namespaces/vanhauser/repositories/thc-hydra', body: repoBody('vanhauser', 'thc-hydra', { description: 'THC Hydra image' }) },
    ]);
    const r = await c.resolve(hydra);
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.data.best.fullName).toBe('vanhauser/thc-hydra');
    expect(r.data.evidence.level).toBe('strong');
    expect(r.data.unverified.map(u => u.fullName)).toEqual(['oryd/hydra']); // shown for transparency, never asserted
  });

  it('an official image with the same name is not automatically the tool', async () => {
    const { c } = client([
      { match: '/v2/namespaces/library/repositories/nmap', body: repoBody('library', 'nmap', { description: 'A totally different official thing' }) },
      { match: '/v2/search/', body: { count: 0, results: [] } },
    ]);
    const r = await c.resolve(nmap);
    expect(r).toMatchObject({ found: false, reason: 'unverified' });
  });

  it('reports not_found only when Hub answered definitively with nothing relevant', async () => {
    const { c } = client([
      { match: '/v2/namespaces/library/', status: 404, body: {} },
      { match: '/v2/search/', body: { count: 1, results: [searchItem('unrelated/webserver', 1)] } },
    ]);
    expect(await c.resolve(buildToolProfile('zzz-no-tool'))).toMatchObject({ found: false, reason: 'not_found' });
  });

  it('does NOT claim "not found" when the lookups merely failed — network and rate-limit reasons are preserved', async () => {
    const down = client([{ match: '', throws: { message: 'connect ETIMEDOUT', code: 'ETIMEDOUT' } }]);
    expect(await down.c.resolve(nmap)).toMatchObject({ found: false, reason: 'network_error' });

    const limited = client([{ match: '', status: 429, headers: { 'Retry-After': '30' } }]);
    expect(await limited.c.resolve(nmap)).toMatchObject({ found: false, reason: 'rate_limited', retryAfterMs: 30_000 });
  });

  it('rejects an unusable name without any request', async () => {
    const { c, m } = client([{ match: '', body: {} }]);
    expect(await c.resolve(buildToolProfile('../../etc'))).toMatchObject({ found: false, reason: 'invalid_input' });
    expect(m.calls).toHaveLength(0);
  });
});
