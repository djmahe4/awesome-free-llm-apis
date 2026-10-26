import { httpGetJson, httpGetText, type HttpOptions } from './http.js';
import { notFound, failFromHttp, isRateLimited, type Lookup } from './grounding.js';
import { BoundedMap } from './bounded-map.js';
import { MANIFEST_BASENAMES, parseManifest, type Dependency, type ManifestInfo } from './RepoManifests.js';

export interface RepoMeta {
  fullName: string;
  description?: string;
  homepage?: string;
  defaultBranch: string;
  language?: string;
  topics: string[];
  stars: number;
  archived: boolean;
  fork: boolean;
  license?: string;
  pushedAt?: string;
  htmlUrl: string;
}

export interface SkillInfo { name: string; path: string }

export interface RepoUnderstanding {
  meta: RepoMeta;
  treeTruncated: boolean;
  fileCount: number;
  readmePath?: string;
  readmeExcerpt?: string;
  manifests: ManifestInfo[];
  dependencies: Dependency[];
  skills: { total: number; roots: string[]; samples: SkillInfo[] };
  /** Repo files that look like an MCP server or MCP client config. */
  mcp: { configFiles: string[]; serverFiles: string[] };
  /** Fenced code blocks found under install/usage-style README headings. */
  usage: { install: string[]; run: string[] };
  /** Notes about what we could not read (never silent). */
  notes: string[];
}

const README_NAMES = ['README.md', 'README.rst', 'README.txt', 'README', 'readme.md', 'Readme.md'];
const SKILL_RE = /(^|\/)SKILL\.md$/i;
const MCP_CONFIG_RE = /(^|\/)(\.mcp\.json|mcp\.json|server\.json|glama\.json)$/i;
const MCP_SERVER_RE = /(^|\/)(mcp[_-]?server|[^/]*mcp[^/]*)\.(py|ts|js|go)$|(^|\/)mcp[_-]?server\/__init__\.py$/i;
const MAX_MANIFESTS = 8;

const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/');

/** Fenced code blocks (``` ... ```) with the nearest preceding heading text. */
export function extractUsage(readme: string): { install: string[]; run: string[] } {
  const install: string[] = [];
  const run: string[] = [];
  let heading = '';
  const lines = readme.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const h = /^#{1,6}\s+(.*)$/.exec(lines[i]);
    if (h) { heading = h[1].toLowerCase(); continue; }
    if (!/^\s*```/.test(lines[i])) continue;
    const block: string[] = [];
    for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) block.push(lines[i]);
    const text = block.join('\n').trim();
    if (!text || text.length > 600) continue;
    if (/install|setup|getting started|quick ?start|requirements|build/.test(heading)) {
      if (install.length < 5) install.push(text);
    } else if (/usage|example|run|command|cli|how to/.test(heading)) {
      if (run.length < 5) run.push(text);
    }
  }
  return { install, run };
}

/** Successful GitHub answers, shared by every client instance for a few minutes (one lookup costs ~12 requests of a 60/hour quota). */
const CACHE_TTL_MS = 5 * 60_000;
const responseCache = new BoundedMap<string, { at: number; res: any }>(200);
export function resetGithubCache(): void { responseCache.clear(); }

/** A personal access token raises the API limit from 60 to 5000 requests/hour. Sent to the GitHub hosts only, never logged. */
const githubToken = (): string | undefined => process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined;

export class GithubRepoClient {
  private readonly http: HttpOptions;
  private readonly cacheOn: boolean;
  /** `cache`: default on, except with an injected fetch (tests), which keeps its own call counts. */
  constructor(opts: HttpOptions & { cache?: boolean } = {}) {
    const { cache, ...http } = opts;
    this.http = http;
    this.cacheOn = cache ?? !http.fetchImpl;
  }

  private headers(accept: string): Record<string, string> {
    const token = githubToken();
    return { Accept: accept, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(this.http.headers ?? {}) };
  }

  private async cached<T extends { ok: boolean }>(url: string, fetcher: () => Promise<T>): Promise<T> {
    if (!this.cacheOn) return fetcher();
    const now = (this.http.now ?? Date.now)();
    const hit = responseCache.get(url);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.res as T;
    const res = await fetcher();
    if (res.ok) responseCache.set(url, { at: now, res }); // failures are never cached
    return res;
  }

  async getMeta(owner: string, repo: string): Promise<Lookup<RepoMeta>> {
    const url = `https://api.github.com/repos/${enc(owner)}/${enc(repo)}`;
    const res = await this.cached(url, () => httpGetJson<any>(url, { ...this.http, headers: this.headers('application/vnd.github+json') }));
    if (!res.ok || !res.json) {
      if (isRateLimited(res)) {
        return notFound('rate_limited', 'GitHub API quota exhausted (set GITHUB_TOKEN to raise the limit)', res.url, res.retryAfterMs);
      }
      return failFromHttp(res, `GitHub ${owner}/${repo}`);
    }
    const j = res.json;
    return {
      found: true, url: j.html_url ?? `https://github.com/${owner}/${repo}`,
      data: {
        fullName: j.full_name ?? `${owner}/${repo}`, description: j.description ?? undefined,
        homepage: j.homepage || undefined, defaultBranch: j.default_branch ?? 'HEAD',
        language: j.language ?? undefined, topics: Array.isArray(j.topics) ? j.topics : [],
        stars: j.stargazers_count ?? 0, archived: !!j.archived, fork: !!j.fork,
        license: j.license?.spdx_id ?? undefined, pushedAt: j.pushed_at,
        htmlUrl: j.html_url ?? `https://github.com/${owner}/${repo}`,
      },
    };
  }

  private async raw(owner: string, repo: string, ref: string, path: string): Promise<string | null> {
    const url = `https://raw.githubusercontent.com/${enc(owner)}/${enc(repo)}/${enc(ref)}/${enc(path)}`;
    const res = await this.cached(url, () => httpGetText(url, { ...this.http, headers: this.headers('text/plain, text/markdown, */*') }));
    return res.ok && typeof res.text === 'string' ? res.text : null;
  }

  /** Reads the repo into a structured summary. Anything unreadable is listed in `notes`. */
  async understand(owner: string, repo: string): Promise<Lookup<RepoUnderstanding>> {
    const metaLookup = await this.getMeta(owner, repo);
    if (!metaLookup.found) return metaLookup;
    const meta = metaLookup.data;
    const notes: string[] = [];
    if (meta.archived) notes.push('Repository is archived (read-only upstream).');

    const treeUrl = `https://api.github.com/repos/${enc(owner)}/${enc(repo)}/git/trees/${enc(meta.defaultBranch)}?recursive=1`;
    const treeRes = await this.cached(treeUrl, () => httpGetJson<any>(treeUrl, { ...this.http, headers: this.headers('application/vnd.github+json') }));
    let paths: string[] = [];
    let treeTruncated = false;
    if (treeRes.ok && Array.isArray(treeRes.json?.tree)) {
      paths = treeRes.json.tree.filter((t: any) => t.type === 'blob').map((t: any) => String(t.path));
      treeTruncated = !!treeRes.json.truncated;
      if (treeTruncated) notes.push('File tree was truncated by GitHub; counts are lower bounds.');
    } else {
      notes.push(isRateLimited(treeRes)
        ? 'GitHub API quota exhausted while reading the file tree (set GITHUB_TOKEN to raise the limit); only the README was read.'
        : `File tree unavailable (${treeRes.status || treeRes.error || 'error'}); only the README was read.`);
    }

    const ref = meta.defaultBranch;
    const rootFiles = new Set(paths.filter(p => !p.includes('/')));
    const readmePath = README_NAMES.find(n => rootFiles.has(n)) ?? (paths.length ? undefined : README_NAMES[0]);
    let readme: string | null = null;
    if (readmePath) readme = await this.raw(owner, repo, ref, readmePath);
    if (readmePath && readme === null) notes.push(`Could not read ${readmePath}.`);

    // Manifests: shallow ones first (depth ≤ 1), capped so a monorepo cannot fan out.
    const manifestPaths = paths.filter(p => MANIFEST_BASENAMES.test(p) && p.split('/').length <= 2
      && !/(^|\/)(node_modules|vendor|test|tests|examples?)\//i.test(p))
      .sort((a, b) => a.split('/').length - b.split('/').length).slice(0, MAX_MANIFESTS);
    const manifests: ManifestInfo[] = [];
    await Promise.all(manifestPaths.map(async p => {
      const text = await this.raw(owner, repo, ref, p);
      if (text === null) { notes.push(`Could not read ${p}.`); return; }
      const m = parseManifest(p, text);
      if (m) manifests.push(m);
    }));
    manifests.sort((a, b) => a.file.localeCompare(b.file));

    const skillPaths = paths.filter(p => SKILL_RE.test(p));
    const skillRoots = [...new Set(skillPaths.map(p => p.split('/').slice(0, -2).join('/')))];
    const skills = {
      total: skillPaths.length, roots: skillRoots.slice(0, 5),
      samples: skillPaths.slice(0, 8).map(p => ({ name: p.split('/').slice(-2, -1)[0], path: p })),
    };

    const mcp = {
      configFiles: paths.filter(p => MCP_CONFIG_RE.test(p) && !p.includes('.claude/skills')).slice(0, 6),
      serverFiles: paths.filter(p => MCP_SERVER_RE.test(p) && !p.includes('.claude/skills')).slice(0, 8),
    };

    const seen = new Set<string>();
    const dependencies = manifests.flatMap(m => m.dependencies).filter(d => {
      const k = `${d.ecosystem}:${d.name}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });

    return {
      found: true, url: meta.htmlUrl,
      data: {
        meta, treeTruncated, fileCount: paths.length, readmePath,
        readmeExcerpt: readme ? readme.slice(0, 1500) : undefined,
        manifests, dependencies, skills, mcp,
        usage: readme ? extractUsage(readme) : { install: [], run: [] },
        notes,
      },
    };
  }
}
