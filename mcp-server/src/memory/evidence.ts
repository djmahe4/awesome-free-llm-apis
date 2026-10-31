import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Retrieved context with provenance. A retrieval hit used to reach the prompt as bare text: the file it came from,
 * the hash it was indexed under and the time were dropped, and nothing re-checked it against the file on disk, so
 * an edited or deleted file kept feeding old content. Evidence keeps those fields and `keepFreshEvidence` re-hashes
 * the file just before use.
 */
export interface Evidence {
  /** Workspace-relative path; absent for a note that is not tied to a file (kept, but cannot be verified). */
  path?: string;
  lines?: [number, number];
  /** sha256 of the file content when it was indexed. */
  contentHash: string;
  source: 'vector' | 'grep' | 'graph' | 'wiki' | 'probe';
  retrievedAt: number;
  text: string;
}

export type Freshness = 'fresh' | 'stale' | 'missing';

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Resolves a workspace-relative path and refuses anything that lands outside the workspace. */
function insideWorkspace(root: string, rel: string): string | null {
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  return full === base || full.startsWith(base + path.sep) ? full : null;
}

export async function checkFresh(ev: Evidence, workspaceRoot: string): Promise<Freshness> {
  if (!ev.path) return 'fresh';
  const full = insideWorkspace(workspaceRoot, ev.path);
  if (!full) return 'missing';
  try {
    return sha256(await fs.readFile(full, 'utf-8')) === ev.contentHash ? 'fresh' : 'stale';
  } catch {
    return 'missing';
  }
}

/** A vector-store hit (VectorEntry shape) as evidence. Kept loose: hits come from JSON metadata. */
export function evidenceFromHit(hit: { content?: string; contentHash?: string; timestamp?: number; path?: string; metadata?: any }): Evidence {
  const p = hit.path ?? hit.metadata?.path;
  return {
    path: typeof p === 'string' && p ? p.split(String.fromCharCode(92)).join('/') : undefined, // one spelling on every platform
    contentHash: hit.contentHash ?? hit.metadata?.contentHash ?? '',
    source: 'vector',
    retrievedAt: typeof hit.timestamp === 'number' ? hit.timestamp : Date.now(),
    text: hit.content ?? '',
  };
}

export async function keepFreshEvidence(
  list: Evidence[],
  workspaceRoot: string,
): Promise<{ kept: Evidence[]; dropped: Array<{ evidence: Evidence; reason: 'stale' | 'missing' }> }> {
  const kept: Evidence[] = [];
  const dropped: Array<{ evidence: Evidence; reason: 'stale' | 'missing' }> = [];
  for (const e of list) {
    const state = await checkFresh(e, workspaceRoot);
    if (state === 'fresh') kept.push(e);
    else dropped.push({ evidence: e, reason: state });
  }
  return { kept, dropped };
}

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.c', '.cpp', '.cc', '.h', '.hpp', '.lua', '.java', '.sh', '.rb', '.php', '.cs', '.swift']);
const CONFIG_EXTS = new Set(['.json', '.yml', '.yaml', '.toml', '.env', '.xml', '.ini']);

function rank(p?: string): number {
  if (!p) return 3;
  const ext = path.extname(p).toLowerCase();
  return CODE_EXTS.has(ext) ? 1 : CONFIG_EXTS.has(ext) ? 2 : 3;
}

/** Code first, then config, then everything else; a stable sort, so relevance order holds inside a group. */
export function sortCodeFirst<T extends { path?: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => rank(a.path) - rank(b.path));
}

/**
 * Files a cached context result quotes: `--- FILE: <path> ---` (grep) and `--- RELATED FILE: <path> (via dep-graph) ---`
 * (graph expansion) headers. An entry can hold several headers, so every one is collected.
 */
export function filesCitedIn(results: string[]): string[] {
  const out: string[] = [];
  for (const entry of results) {
    for (const m of entry.matchAll(/--- (?:RELATED )?FILE: (.+?)(?: \(via dep-graph\))? ---/g)) {
      if (!out.includes(m[1])) out.push(m[1]);
    }
  }
  return out;
}

/** True when any file was modified after `since` (ms) or can no longer be read: the cached result is stale. */
export async function anyChangedSince(files: string[], workspaceRoot: string, since: number): Promise<boolean> {
  for (const f of files) {
    const full = insideWorkspace(workspaceRoot, f);
    if (!full) return true;
    try {
      if ((await fs.stat(full)).mtimeMs > since) return true;
    } catch {
      return true;
    }
  }
  return false;
}
