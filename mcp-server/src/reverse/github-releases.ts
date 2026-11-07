import { httpGetJson, type FetchLike } from '../utils/http.js';
import { isRateLimited } from '../utils/grounding.js';

export type AssetCategory =
  | 'binary_native'
  | 'asar'
  | 'ai_model'
  | 'firmware'
  | 'archive'
  | 'installer'
  | 'document'
  | 'other';

export interface GitHubReleaseAsset {
  id: number;
  name: string;
  size: number;
  content_type: string;
  browser_download_url: string;
  category: AssetCategory;
  candidateForAnalyzeArtifact: boolean;
}

export interface GitHubReleaseInfo {
  id: number;
  tag_name: string;
  name: string;
  published_at?: string;
  assets: GitHubReleaseAsset[];
}

export interface ListReleaseAssetsResult {
  success: boolean;
  releases: GitHubReleaseInfo[];
  assets: GitHubReleaseAsset[];
  error?: string;
}

export function classifyAsset(name: string, contentType = ''): AssetCategory {
  const lower = name.toLowerCase();
  const lowerCt = contentType.toLowerCase();

  if (lower.endsWith('.asar')) return 'asar';
  if (lower.endsWith('.gguf') || lower.endsWith('.safetensors') || lower.endsWith('.onnx')) return 'ai_model';
  if (lower.endsWith('.hex') || lower.endsWith('.rom') || lower.endsWith('.fw') || (lower.endsWith('.bin') && /firmware|fw|bios/i.test(lower))) {
    return 'firmware';
  }
  if (lower.endsWith('.deb') || lower.endsWith('.rpm') || lower.endsWith('.dmg') || lower.endsWith('.msi') || lower.endsWith('.pkg')) {
    return 'installer';
  }
  if (
    lower.endsWith('.zip') ||
    lower.endsWith('.tar.gz') ||
    lower.endsWith('.tgz') ||
    lower.endsWith('.tar.bz2') ||
    lower.endsWith('.tar.xz') ||
    lower.endsWith('.txz') ||
    lower.endsWith('.tar.zst') ||
    lower.endsWith('.7z')
  ) {
    return 'archive';
  }
  if (
    lower.endsWith('.txt') ||
    lower.endsWith('.md') ||
    lower.endsWith('.pdf') ||
    lower.endsWith('.sha256') ||
    lower.endsWith('.sha512') ||
    lower.endsWith('.sig') ||
    lower.endsWith('.asc')
  ) {
    return 'document';
  }
  if (
    lower.endsWith('.exe') ||
    lower.endsWith('.dll') ||
    lower.endsWith('.so') ||
    lower.endsWith('.dylib') ||
    lower.endsWith('.elf') ||
    lower.endsWith('.node') ||
    lower.endsWith('.bin') ||
    /[-_.](linux|darwin|macos|windows|amd64|x86_64|arm64|x64)/i.test(lower) ||
    lowerCt.includes('x-executable') ||
    lowerCt.includes('x-sharedlib') ||
    lowerCt.includes('x-msdownload')
  ) {
    return 'binary_native';
  }
  return 'other';
}

export async function listReleaseAssets(
  owner: string,
  repo: string,
  options: { fetchImpl?: FetchLike; token?: string; limit?: number } = {}
): Promise<ListReleaseAssetsResult> {
  const token = options.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const clampedLimit = Math.min(Math.max(options.limit ?? 5, 1), 100);
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=${clampedLimit}`;

  try {
    const res = await httpGetJson<any[]>(url, {
      fetchImpl: options.fetchImpl,
      headers,
    });

    if (!res.ok || !Array.isArray(res.json)) {
      if (isRateLimited(res)) {
        return {
          success: false,
          releases: [],
          assets: [],
          error: 'GitHub API quota exhausted or rate limit hit. Provide a valid GITHUB_TOKEN.',
        };
      }
      return {
        success: false,
        releases: [],
        assets: [],
        error: `Failed to fetch GitHub releases: status ${res.status || res.error || 'unknown'}`,
      };
    }

    const releases: GitHubReleaseInfo[] = [];
    const allAssets: GitHubReleaseAsset[] = [];

    for (const rel of res.json) {
      const relAssets: GitHubReleaseAsset[] = [];
      if (Array.isArray(rel.assets)) {
        for (const rawAsset of rel.assets) {
          const category = classifyAsset(rawAsset.name || '', rawAsset.content_type || '');
          const candidate = ['binary_native', 'asar', 'ai_model', 'firmware', 'archive'].includes(category);
          const asset: GitHubReleaseAsset = {
            id: rawAsset.id,
            name: rawAsset.name,
            size: Number(rawAsset.size || 0),
            content_type: rawAsset.content_type || 'application/octet-stream',
            browser_download_url: rawAsset.browser_download_url,
            category,
            candidateForAnalyzeArtifact: candidate,
          };
          relAssets.push(asset);
          allAssets.push(asset);
        }
      }
      releases.push({
        id: rel.id,
        tag_name: rel.tag_name || '',
        name: rel.name || rel.tag_name || '',
        published_at: rel.published_at,
        assets: relAssets,
      });
    }

    return {
      success: true,
      releases,
      assets: allAssets,
    };
  } catch (err: any) {
    return {
      success: false,
      releases: [],
      assets: [],
      error: `Network error querying GitHub releases: ${err.message || String(err)}`,
    };
  }
}
