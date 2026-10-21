import { httpGetJson, type HttpOptions } from './http.js';
import { failFromHttp, notFound, SAFE_NAME_RE, type GroundingHint, type Lookup } from './grounding.js';
import { assessEvidence, isGrounded, type Evidence, type ToolProfile } from './groundingEvidence.js';

/**
 * Docker Hub grounding client — official REST API only (no page scraping, so the
 * Cloudflare browser challenge that the hub.docker.com SPA serves to automated
 * browsers is irrelevant here; the API host answers plain HTTP).
 *
 * Endpoint status, verified against docs.docker.com/reference/api/hub/latest AND live:
 *   documented : GET /v2/namespaces/{ns}/repositories/{repo}
 *                GET /v2/namespaces/{ns}/repositories/{repo}/tags
 *   NOT in the official reference, but live and unauthenticated: GET /v2/search/repositories/
 *     — so search parsing is deliberately tolerant and a missing field never throws.
 * Limits (documented): per-minute, X-RateLimit-Limit/Remaining/Reset, 429 + Retry-After
 * (observed anonymous limit: 180/min). The http layer honours those.
 * Official images live in the `library` namespace and come back from search as a bare name.
 */

const HUB = 'https://hub.docker.com';

export interface DockerRepoSummary {
  fullName: string;       // "instrumentisto/nmap" or "ubuntu" (official)
  namespace: string;      // "library" for official images
  repo: string;
  description: string;
  stars: number;
  pulls: number;
  isOfficial: boolean;
  isAutomated: boolean;
  pullCommand: string;    // derived from the grounded name only
  url: string;
}
export interface DockerRepoDetail extends DockerRepoSummary {
  lastUpdated?: string;
  categories: string[];
  /** First ~1500 chars of the repo's own full_description (its README on Hub). */
  aboutExcerpt: string;
  storageBytes?: number;
}
export interface DockerTag { name: string; lastUpdated?: string; sizeBytes?: number; digest?: string; platforms: string[] }
export interface DockerTagPage { tags: DockerTag[]; total: number; hasMore: boolean }
export interface DockerSearchPage { results: DockerRepoSummary[]; total: number; hasMore: boolean }
export interface DockerResolution {
  best: DockerRepoDetail;
  /** Why `best` is believed to be the registered tool (not merely a same-named image). */
  evidence: Evidence;
  /** Other grounded images, best first. */
  alternatives: Array<{ repo: DockerRepoSummary; evidence: Evidence }>;
  /** Same-name images that could NOT be tied to the tool — listed for transparency, never asserted. */
  unverified: DockerRepoSummary[];
  /** URLs actually queried — provenance for the answer. */
  checked: string[];
}

const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const toStr = (v: unknown): string => (typeof v === 'string' ? v : '');

export function splitRepoName(repoName: string): { namespace: string; repo: string } {
  const i = repoName.indexOf('/');
  return i === -1 ? { namespace: 'library', repo: repoName } : { namespace: repoName.slice(0, i), repo: repoName.slice(i + 1) };
}

function summarize(namespace: string, repo: string, o: Record<string, any>, isOfficialHint?: boolean): DockerRepoSummary {
  const isOfficial = isOfficialHint ?? (namespace === 'library');
  return {
    fullName: isOfficial ? repo : `${namespace}/${repo}`,
    namespace, repo,
    description: toStr(o.short_description) || toStr(o.description),
    stars: toNum(o.star_count),
    pulls: toNum(o.pull_count),
    isOfficial,
    isAutomated: o.is_automated === true,
    pullCommand: `docker pull ${isOfficial ? repo : `${namespace}/${repo}`}`,
    url: isOfficial ? `${HUB}/_/${repo}` : `${HUB}/r/${namespace}/${repo}`,
  };
}

/**
 * Ranks search hits for a tool name. Only repos whose own name IS the tool (or contains
 * it) are kept — Hub search is full-text, so unrelated images that merely mention the
 * tool in their description are noise and must not be offered as grounding. Official
 * images win; then exact-name over contains; then popularity.
 */
export function rankCandidates(name: string, results: DockerRepoSummary[]): DockerRepoSummary[] {
  const n = name.toLowerCase();
  const scored: Array<{ r: DockerRepoSummary; score: number }> = [];
  for (const r of results) {
    const repo = r.repo.toLowerCase();
    let base: number;
    if (repo === n) base = 100;
    else if (repo.includes(n)) base = 30;
    else continue;
    scored.push({ r, score: base + (r.isOfficial ? 1000 : 0) + Math.log10(r.pulls + 1) * 5 });
  }
  return scored.sort((a, b) => b.score - a.score).map(s => s.r);
}

export class DockerHubClient {
  constructor(private readonly http: HttpOptions = {}, private readonly base: string = HUB) {}

  private get(path: string) {
    return httpGetJson<any>(`${this.base}${path}`, this.http);
  }

  async search(query: string, opts: { pageSize?: number; page?: number } = {}): Promise<Lookup<DockerSearchPage>> {
    const q = query.trim();
    if (!q || q.length > 100) return notFound('invalid_input', 'search query must be 1-100 characters');
    const pageSize = Math.min(Math.max(opts.pageSize ?? 10, 1), 100);
    const page = Math.max(opts.page ?? 1, 1);
    const res = await this.get(`/v2/search/repositories/?query=${encodeURIComponent(q)}&page=${page}&page_size=${pageSize}`);
    if (!res.ok) return failFromHttp(res, `Docker Hub search "${q}"`);
    if (!res.json || !Array.isArray(res.json.results)) return notFound('unexpected_response', 'Docker Hub search: response had no results array', res.url);
    const results = (res.json.results as any[])
      .filter(o => typeof o?.repo_name === 'string' && o.repo_name)
      .map(o => { const { namespace, repo } = splitRepoName(o.repo_name); return summarize(namespace, repo, o, o.is_official === true); });
    return { found: true, url: res.url, data: { results, total: toNum(res.json.count), hasMore: !!res.json.next } };
  }

  async getRepository(namespace: string, repo: string): Promise<Lookup<DockerRepoDetail>> {
    if (!SAFE_NAME_RE.test(namespace) || !SAFE_NAME_RE.test(repo)) return notFound('invalid_input', `"${namespace}/${repo}" is not a valid Docker Hub name`);
    const res = await this.get(`/v2/namespaces/${namespace}/repositories/${repo}`);
    if (!res.ok) return failFromHttp(res, `Docker Hub repository ${namespace}/${repo}`);
    const o = res.json;
    if (!o || typeof o !== 'object' || typeof o.name !== 'string') return notFound('unexpected_response', 'Docker Hub repository: unexpected body', res.url);
    const base = summarize(namespace, repo, o);
    const categories = Array.isArray(o.categories) ? o.categories.map((c: any) => toStr(c?.name) || toStr(c?.slug) || (typeof c === 'string' ? c : '')).filter(Boolean) : [];
    return {
      found: true, url: res.url,
      data: { ...base, lastUpdated: toStr(o.last_updated) || undefined, categories, aboutExcerpt: toStr(o.full_description).slice(0, 1500), storageBytes: typeof o.storage_size === 'number' ? o.storage_size : undefined },
    };
  }

  async listTags(namespace: string, repo: string, opts: { pageSize?: number; page?: number } = {}): Promise<Lookup<DockerTagPage>> {
    if (!SAFE_NAME_RE.test(namespace) || !SAFE_NAME_RE.test(repo)) return notFound('invalid_input', `"${namespace}/${repo}" is not a valid Docker Hub name`);
    const pageSize = Math.min(Math.max(opts.pageSize ?? 10, 1), 100);
    const page = Math.max(opts.page ?? 1, 1);
    const res = await this.get(`/v2/namespaces/${namespace}/repositories/${repo}/tags?page=${page}&page_size=${pageSize}`);
    if (!res.ok) return failFromHttp(res, `Docker Hub tags ${namespace}/${repo}`);
    if (!res.json || !Array.isArray(res.json.results)) return notFound('unexpected_response', 'Docker Hub tags: response had no results array', res.url);
    const tags: DockerTag[] = (res.json.results as any[]).filter(t => typeof t?.name === 'string').map(t => {
      const platforms = Array.isArray(t.images)
        ? [...new Set<string>(t.images
            .filter((i: any) => i?.architecture && i.architecture !== 'unknown') // attestation manifests report architecture "unknown"
            .map((i: any) => `${toStr(i.os) || 'linux'}/${i.architecture}${i.variant ? `/${i.variant}` : ''}`))]
        : [];
      return { name: t.name, lastUpdated: toStr(t.last_updated) || undefined, sizeBytes: typeof t.full_size === 'number' ? t.full_size : undefined, digest: toStr(t.digest) || undefined, platforms };
    });
    return { found: true, url: res.url, data: { tags, total: toNum(res.json.count), hasMore: !!res.json.next } };
  }

  /**
   * Finds the Docker Hub repo that IS the registered tool, not merely one with its name.
   * Candidates come from `library/<alias>` plus ranked search hits; each of the top few is
   * read in full and run through assessEvidence. Only strong/domain evidence can become
   * `best`. If the only same-named images fail that test the result is `unverified` (with
   * hints, so the caller can ask), not a guess. `not_found` means Hub answered definitively
   * with nothing relevant; network/rate-limit failures keep their own reason so "could not
   * check" is never reported as "does not exist".
   */
  async resolve(profile: ToolProfile): Promise<Lookup<DockerResolution>> {
    const names = profile.aliases.filter(n => SAFE_NAME_RE.test(n));
    if (names.length === 0) return notFound('invalid_input', `"${profile.name}" is not a valid Docker Hub name`);

    const checked: string[] = [];
    const ranked: DockerRepoSummary[] = [];
    const details = new Map<string, DockerRepoDetail>();
    const softFailures: Array<{ reason: 'rate_limited' | 'network_error' | 'unexpected_response'; detail: string; retryAfterMs?: number }> = [];
    const noteFailure = (r: { found: false; reason: string; detail: string; url?: string; retryAfterMs?: number }) => {
      if (r.url) checked.push(r.url);
      if (r.reason !== 'not_found' && r.reason !== 'invalid_input') softFailures.push(r as any);
    };

    await Promise.all(names.map(async name => {
      const [official, search] = await Promise.all([this.getRepository('library', name), this.search(name, { pageSize: 25 })]);
      if (official.found) { details.set(official.data.fullName, official.data); ranked.push(official.data); checked.push(official.url); } else noteFailure(official);
      if (search.found) { checked.push(search.url); ranked.push(...rankCandidates(name, search.data.results)); } else noteFailure(search);
    }));

    const seen = new Set<string>();
    const unique = ranked.filter(c => (seen.has(c.fullName) ? false : (seen.add(c.fullName), true)));
    unique.sort((a, b) => Number(b.isOfficial) - Number(a.isOfficial));

    if (unique.length === 0) {
      if (softFailures.length > 0) {
        const f = softFailures[0];
        return notFound(f.reason, `could not verify Docker Hub for "${profile.name}": ${f.detail}`, undefined, f.retryAfterMs);
      }
      return notFound('not_found', `no Docker Hub repository named or containing "${profile.name}"`);
    }

    // Read the top few in full: evidence needs the long description, which search results lack.
    const top = unique.slice(0, 4);
    await Promise.all(top.filter(c => !details.has(c.fullName)).map(async c => {
      const d = await this.getRepository(c.namespace, c.repo);
      if (d.found) { details.set(c.fullName, d.data); checked.push(d.url); } else if (d.url) checked.push(d.url);
    }));

    const assessed = top.map(summary => {
      const repo: DockerRepoDetail = details.get(summary.fullName) ?? { ...summary, categories: [], aboutExcerpt: '' };
      const evidence = assessEvidence(profile, { name: repo.repo, owner: repo.namespace === 'library' ? undefined : repo.namespace, text: `${repo.description}\n${repo.aboutExcerpt}` });
      return { repo, evidence };
    });

    const order = { strong: 0, domain: 1, 'name-only': 2 } as const;
    const grounded = assessed
      .filter((a): a is { repo: DockerRepoDetail; evidence: Evidence } => isGrounded(a.evidence))
      .sort((a, b) => order[a.evidence.level] - order[b.evidence.level] || Number(b.repo.isOfficial) - Number(a.repo.isOfficial) || b.repo.pulls - a.repo.pulls);
    const unverified = assessed.filter(a => !isGrounded(a.evidence)).map(a => a.repo);

    if (grounded.length === 0) {
      const hints: GroundingHint[] = unverified.slice(0, 5).map(r => ({
        label: r.fullName, url: r.url, description: r.description || undefined,
        why: `shares the name "${profile.name}" but nothing links it to ${profile.github?.url ?? 'the registered tool'}`,
      }));
      return notFound('unverified', `Docker Hub has ${unverified.length} image(s) named like "${profile.name}", but none could be tied to the registered tool`, undefined, undefined, hints);
    }

    const [first, ...rest] = grounded;
    return {
      found: true, url: first.repo.url,
      data: {
        best: first.repo, evidence: first.evidence,
        alternatives: rest.slice(0, 4).map(g => ({ repo: g.repo, evidence: g.evidence })),
        unverified: unverified.slice(0, 5),
        checked: [...new Set(checked)],
      },
    };
  }
}
