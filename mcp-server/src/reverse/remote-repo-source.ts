import { httpGetJson, httpGetText, type FetchLike } from '../utils/http.js';
import { isRateLimited } from '../utils/grounding.js';
import path from 'node:path';

export interface RemoteFileDescriptor {
  path: string;
  name: string;
  extension: string;
  isSource: boolean;
  importanceScore: number;
  size?: number;
  tags: string[];
}

export interface TreeIndexResult {
  success: boolean;
  owner: string;
  repo: string;
  commitSha: string;
  descriptors: RemoteFileDescriptor[];
  readmeExcerpt?: string;
  error?: string;
}

interface GitHubTreeEntry {
  path?: string;
  type?: string;
  size?: number;
  sha?: string;
  mode?: string;
}

interface GitHubTreePayload {
  sha?: string;
  truncated?: boolean;
  tree?: GitHubTreeEntry[];
  message?: string;
}

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.c', '.cpp', '.cc', '.h', '.hpp',
  '.lua', '.sh', '.rb', '.php', '.cs', '.java'
]);

export class RemoteRepoSource {
  private readonly fetchImpl?: FetchLike;
  private readonly token?: string;

  constructor(options: { fetchImpl?: FetchLike; token?: string } = {}) {
    this.fetchImpl = options.fetchImpl;
    this.token = options.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  }

  private authHeaders(accept = 'application/vnd.github+json'): Record<string, string> {
    return {
      Accept: accept,
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  async indexTree(owner: string, repo: string, ref = 'main'): Promise<TreeIndexResult> {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`;

    try {
      const res = await httpGetJson<GitHubTreePayload>(url, {
        fetchImpl: this.fetchImpl,
        headers: this.authHeaders(),
      });

      if (!res.ok || !res.json || !Array.isArray(res.json.tree)) {
        if (isRateLimited(res) || res.status === 429 || (res.status === 403 && isRateLimited(res))) {
          return {
            success: false, owner, repo, commitSha: '', descriptors: [],
            error: 'GitHub API rate limit exceeded during tree retrieval.',
          };
        }
        if (res.status === 403) {
          return {
            success: false, owner, repo, commitSha: '', descriptors: [],
            error: 'GitHub API access forbidden: check authentication or permissions.',
          };
        }
        if ((res.status === 200 || res.ok) && (!res.json || !Array.isArray(res.json.tree))) {
          return {
            success: false, owner, repo, commitSha: '', descriptors: [],
            error: 'Malformed GitHub tree payload',
          };
        }
        return {
          success: false, owner, repo, commitSha: '', descriptors: [],
          error: `Tree fetch failed: ${res.error || (res.status ? `HTTP ${res.status}` : 'Network error')}`,
        };
      }

      const commitSha = res.json.sha || ref;
      const descriptors: RemoteFileDescriptor[] = [];

      for (const entry of res.json.tree) {
        if (entry.type !== 'blob' || !entry.path) continue;
        const filePath = String(entry.path);
        const ext = path.posix.extname(filePath).toLowerCase();
        const baseName = path.posix.basename(filePath).toLowerCase();
        const isSource = SOURCE_EXTENSIONS.has(ext);

        let score = 0;
        if (/main|index|cli|app|server|core/i.test(baseName)) score += 50;
        if (/auth|security|crypto|secret|token|session/i.test(baseName)) score += 40;
        if (/api|routes|handlers|controller/i.test(filePath)) score += 20;
        if (/test|spec|mock|fixture|dist|build|node_modules/i.test(filePath)) score -= 30;
        if (isSource) score += 10;

        const tags: string[] = [];
        if (isSource) tags.push('source');
        if (/SKILL\.md$/i.test(filePath)) tags.push('skill');
        if (/\.mcp\.json|server\.json/i.test(filePath)) tags.push('mcp');
        if (/package\.json|cargo\.toml|requirements\.txt|go\.mod/i.test(filePath)) tags.push('manifest');

        descriptors.push({
          path: filePath,
          name: path.posix.basename(filePath),
          extension: ext,
          isSource,
          importanceScore: score,
          size: entry.size,
          tags,
        });
      }

      descriptors.sort((a, b) => b.importanceScore - a.importanceScore);

      let readmeExcerpt: string | undefined;
      const readmeDesc = descriptors.find(d => /^readme\.(md|txt|rst)$/i.test(d.name));
      if (readmeDesc) {
        const rawReadme = await this.fetchRawFile(owner, repo, commitSha, readmeDesc.path, 5000);
        if (rawReadme.ok) {
          readmeExcerpt = rawReadme.text.slice(0, 1500);
        }
      }

      return {
        success: true,
        owner,
        repo,
        commitSha,
        descriptors,
        readmeExcerpt,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false, owner, repo, commitSha: '', descriptors: [],
        error: `Network error retrieving tree: ${message}`,
      };
    }
  }

  async shortlistFiles(
    owner: string,
    repo: string,
    ref = 'main',
    options: { query?: string; limit?: number } = {}
  ): Promise<RemoteFileDescriptor[]> {
    const treeRes = await this.indexTree(owner, repo, ref);
    if (!treeRes.success) return [];

    const limit = options.limit || 5;
    const query = (options.query || '').toLowerCase().trim();
    if (!query) {
      return treeRes.descriptors.slice(0, limit);
    }

    const queryTokens = query.split(/[\s,./_-]+/).filter(Boolean);

    const scored = treeRes.descriptors.map(desc => {
      let matchedCount = 0;
      const pLower = desc.path.toLowerCase();
      for (const token of queryTokens) {
        if (pLower.includes(token)) matchedCount++;
      }
      const matchScore = matchedCount > 0
        ? matchedCount * 1000 + desc.importanceScore
        : desc.importanceScore - 1000;
      return { desc, matchScore };
    });

    scored.sort((a, b) => b.matchScore - a.matchScore);
    return scored.slice(0, limit).map(s => s.desc);
  }

  async fetchRawFile(
    owner: string,
    repo: string,
    commitSha: string,
    filePath: string,
    maxBytes = 2_000_000
  ): Promise<{ ok: boolean; text: string; error?: string }> {
    const cleanPath = (filePath || '').replace(/\\/g, '/').trim();
    const normalized = path.posix.normalize(cleanPath);

    if (!cleanPath || !normalized || normalized === '.' || normalized.startsWith('..') || normalized.startsWith('/')) {
      return { ok: false, text: '', error: 'Path traversal or absolute path rejected' };
    }

    const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(commitSha)}/${normalized.split('/').map(encodeURIComponent).join('/')}`;

    try {
      const res = await httpGetText(url, {
        fetchImpl: this.fetchImpl,
        headers: this.authHeaders('text/plain, text/markdown, */*'),
      });

      if (!res.ok || typeof res.text !== 'string') {
        return {
          ok: false,
          text: '',
          error: res.error || (res.status ? `HTTP ${res.status}` : 'Network error'),
        };
      }

      if (res.text.length > maxBytes) {
        return { ok: true, text: res.text.slice(0, maxBytes) };
      }

      return { ok: true, text: res.text };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, text: '', error: message };
    }
  }
}
