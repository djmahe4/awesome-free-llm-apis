/**
 * ContentAddressableCheckpoint.ts — OMP-Style Content-Addressable Storage (CAS)
 *
 * Provides zero-waste workspace snapshotting and transactional multi-file rollback.
 *
 * Architecture (OMP / Hashline CAS):
 *   1. Blobs are indexed in an in-memory & file-backed store by SHA-256 hash.
 *   2. Checkpoints store only manifests ({ [relPath]: sha256_hash }), NOT duplicated file trees.
 *   3. If 99 of 100 files are unchanged across 10 checkpoints, 0 duplicate bytes are stored.
 *   4. Multi-file rollback or commit is instantaneous and atomic.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import { resolveWithin } from '../utils/workspace-roots.js';

export interface CheckpointManifest {
  checkpointId: string;
  sessionId: string;
  timestamp: number;
  description: string;
  files: Record<string, string>; // relPath -> contentHash (SHA-256)
}

export class ContentAddressableStore {
  // In-memory CAS blob storage (hash -> string content)
  private blobs: Map<string, string> = new Map();
  // Manifest history (checkpointId -> CheckpointManifest)
  private manifests: Map<string, CheckpointManifest> = new Map();
  // Session-ordered checkpoint list
  private sessionCheckpoints: Map<string, string[]> = new Map();
  // Per-file undo ring buffers (key = `${resolvedWsRoot}\u0000${relPath}` → versions,
  // newest FIRST, each entry the PRE-apply content; null = file did not exist yet).
  private fileHistory: Map<string, Array<string | null>> = new Map();
  // Disk persistence root (<baseDir>/.free-llm-mcp/cas). Null = memory-only
  // (the default): flush/load are safe no-ops until initCasPersistence() is
  // called — tests and library consumers get zero disk I/O by accident.
  private persistenceDir: string | null = null;

  private historyKey(resolvedWsRoot: string, relPath: string): string {
    return `${resolvedWsRoot}\u0000${relPath}`;
  }

  /**
   * Record the pre-apply version of each file before it is overwritten.
   * Newest-first ring buffer per (workspaceRoot, relPath), capped at
   * CAS_FILE_HISTORY_DEPTH (default 3) — the oldest version is evicted, so a
   * file supports at most `depth` undo_file pops before "No more history".
   */
  recordFileVersions(resolvedWsRoot: string, versions: Record<string, string | null>): void {
    const depth = Number(process.env.CAS_FILE_HISTORY_DEPTH) || 3;
    for (const [relPath, content] of Object.entries(versions)) {
      const key = this.historyKey(resolvedWsRoot, relPath);
      const entry = this.fileHistory.get(key) ?? [];
      entry.unshift(content);
      if (entry.length > depth) entry.length = depth;
      this.fileHistory.set(key, entry);
    }
  }

  /**
   * Newest-first snapshot of a file's undo history (read-only).
   * Includes null slots (file did not exist before that apply).
   */
  fileHistoryVersions(resolvedWsRoot: string, relPath: string): Array<string | null> {
    return [...(this.fileHistory.get(this.historyKey(resolvedWsRoot, relPath)) ?? [])];
  }

  /**
   * Pop the newest recorded version of `relPath` and restore it to disk
   * atomically (tmp + rename). A null slot means the file was created by the
   * apply being undone — restoring "it did not exist" removes the file.
   * Path-guarded: `relPath` must resolve inside `resolvedWsRoot`.
   * Throws `No more history` when the buffer is empty (or absent).
   */
  async undoFileVersionToDisk(
    resolvedWsRoot: string,
    relPath: string
  ): Promise<{ restored: boolean; remainingDepth: number }> {
    const key = this.historyKey(resolvedWsRoot, relPath);
    const entry = this.fileHistory.get(key);
    if (!entry || entry.length === 0) {
      throw new Error('No more history');
    }

    const resolvedRoot = path.resolve(resolvedWsRoot);
    const fullPath = resolveWithin(resolvedRoot, relPath);
    if (!fullPath) {
      throw new Error(`Security error: invalid relative path in file history: ${relPath}`);
    }

    const prior = entry[0];

    if (prior === null) {
      await fs.remove(fullPath).catch(() => { /* already gone */ });
    } else {
      await fs.ensureDir(path.dirname(fullPath));
      const tmpPath = `${fullPath}.cas-undo.tmp`;
      await fs.writeFile(tmpPath, prior, 'utf-8');
      await fs.rename(tmpPath, fullPath);
    }

    entry.shift();
    if (entry.length === 0) this.fileHistory.delete(key);

    return { restored: true, remainingDepth: entry.length };
  }

  /**
   * Compute SHA-256 hash of content (returns 16-character hex digest for efficient indexing).
   */
  hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Store a content blob in CAS. Returns the content hash.
   * If the blob already exists, no extra memory or storage is used (deduplication).
   */
  putBlob(content: string): string {
    const hash = this.hashContent(content);
    if (!this.blobs.has(hash)) {
      this.blobs.set(hash, content);
    }
    return hash;
  }

  /**
   * Retrieve a content blob by hash.
   */
  getBlob(hash: string): string | undefined {
    return this.blobs.get(hash);
  }

  /**
   * Create a space-efficient checkpoint across a set of workspace files.
   * Only stores the manifest of { relPath: hash }, deduplicating unchanged blobs.
   */
  createCheckpoint(
    sessionId: string,
    description: string,
    fileMap: Record<string, string> // relPath -> content
  ): CheckpointManifest {
    const checkpointId = `chk-${sessionId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const manifestFiles: Record<string, string> = {};

    for (const [relPath, content] of Object.entries(fileMap)) {
      const hash = this.putBlob(content);
      manifestFiles[relPath] = hash;
    }

    const manifest: CheckpointManifest = {
      checkpointId,
      sessionId,
      timestamp: Date.now(),
      description,
      files: manifestFiles,
    };

    this.manifests.set(checkpointId, manifest);

    const sessionList = this.sessionCheckpoints.get(sessionId) || [];
    sessionList.push(checkpointId);
    this.sessionCheckpoints.set(sessionId, sessionList);

    return manifest;
  }

  /**
   * Retrieve a checkpoint manifest.
   */
  getCheckpoint(checkpointId: string): CheckpointManifest | undefined {
    return this.manifests.get(checkpointId);
  }

  /**
   * List all checkpoints for a session in chronological order.
   */
  listSessionCheckpoints(sessionId: string): CheckpointManifest[] {
    const ids = this.sessionCheckpoints.get(sessionId) || [];
    return ids.map((id) => this.manifests.get(id)!).filter(Boolean);
  }

  /**
   * Restore all files from a checkpoint manifest as a flat record of { relPath: content }.
   */
  restoreCheckpointContent(checkpointId: string): Record<string, string> | undefined {
    const manifest = this.manifests.get(checkpointId);
    if (!manifest) return undefined;

    const restored: Record<string, string> = {};
    for (const [relPath, hash] of Object.entries(manifest.files)) {
      const content = this.getBlob(hash);
      if (content !== undefined) {
        restored[relPath] = content;
      }
    }
    return restored;
  }

  /**
   * Restore checkpoint directly to disk transactionally.
   */
  async restoreCheckpointToDisk(
    checkpointId: string,
    workspaceRoot: string
  ): Promise<{ restoredCount: number; files: string[] }> {
    const restoredMap = this.restoreCheckpointContent(checkpointId);
    if (!restoredMap) {
      throw new Error(`Checkpoint ${checkpointId} not found in CAS.`);
    }

    const restoredFiles: string[] = [];
    const resolvedRoot = path.resolve(workspaceRoot);
    for (const [relPath, content] of Object.entries(restoredMap)) {
      const fullPath = resolveWithin(resolvedRoot, relPath);
      // Path traversal guard: must stay within workspaceRoot (symlinks resolved)
      if (!fullPath) {
        throw new Error(`Security error: invalid relative path in CAS checkpoint: ${relPath}`);
      }
      // Write atomically via temp file
      const tmpPath = `${fullPath}.cas-restore.tmp`;
      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(tmpPath, content, 'utf-8');
      await fs.rename(tmpPath, fullPath);
      restoredFiles.push(relPath);
    }

    return {
      restoredCount: restoredFiles.length,
      files: restoredFiles,
    };
  }

  /**
   * Get storage statistics (total blobs, deduplication savings).
   */
  getStats(): { totalBlobs: number; totalCheckpoints: number; inMemoryBlobBytes: number } {
    let bytes = 0;
    for (const content of this.blobs.values()) {
      bytes += Buffer.byteLength(content, 'utf-8');
    }
    return {
      totalBlobs: this.blobs.size,
      totalCheckpoints: this.manifests.size,
      inMemoryBlobBytes: bytes,
    };
  }

  /**
   * Enable disk persistence rooted at `<baseDir>/.free-llm-mcp/cas`.
   * Creates nothing on disk — I/O only happens on flush/load/prune.
   * Returns the resolved persistence directory.
   */
  initCasPersistence(baseDir: string): string {
    this.persistenceDir = path.resolve(baseDir, '.free-llm-mcp', 'cas');
    return this.persistenceDir;
  }

  /**
   * Persist the in-memory CAS to disk (R2): every blob as `blobs/<sha256>`
   * plus `index.json` holding manifests and the per-file undo history (history
   * entries are stored as blob hashes so checkpoint content is deduplicated —
   * a pre-apply version always equals the matching checkpoint blob).
   *
   * Write order: blobs FIRST, then index.json (both atomic: tmp + rename), so
   * a crash can only ever leave unreferenced blob files — never an index
   * pointing at missing blobs (those orphans are GC'd by pruneCasOnBoot).
   *
   * Returns false when persistence was never initialized (no disk I/O).
   */
  async flushCasToDisk(): Promise<boolean> {
    if (!this.persistenceDir) return false;
    const casDir = this.persistenceDir;
    const blobsDir = path.join(casDir, 'blobs');
    await fs.ensureDir(blobsDir);

    // Serialize fileHistory to hash refs (putBlob dedups against checkpoint blobs).
    const historyOut: Record<string, Array<string | null>> = {};
    for (const [key, versions] of this.fileHistory) {
      historyOut[key] = versions.map(v => (v === null ? null : this.putBlob(v)));
    }

    // Blobs are content-addressed and immutable — skip ones already on disk.
    for (const [hash, content] of this.blobs) {
      const blobPath = path.join(blobsDir, hash);
      if (await fs.pathExists(blobPath)) continue;
      const tmpPath = `${blobPath}.tmp`;
      await fs.writeFile(tmpPath, content, 'utf-8');
      await fs.rename(tmpPath, blobPath);
    }

    const index = {
      version: 1,
      manifests: [...this.manifests.values()],
      fileHistory: historyOut,
    };
    const indexPath = path.join(casDir, 'index.json');
    const tmpIndex = `${indexPath}.tmp`;
    await fs.writeFile(tmpIndex, JSON.stringify(index), 'utf-8');
    await fs.rename(tmpIndex, indexPath);
    return true;
  }

  /**
   * Hydrate memory from disk: read `index.json` (manifests + fileHistory) and
   * eagerly load every blob file. Merges — existing in-memory state is never
   * discarded, so calling this after a flush round-trips exactly.
   * Returns false when uninitialized or index.json is missing/corrupt.
   */
  async loadCasFromDisk(): Promise<boolean> {
    if (!this.persistenceDir) return false;
    const casDir = this.persistenceDir;

    let index: {
      version?: number;
      manifests?: CheckpointManifest[];
      fileHistory?: Record<string, Array<string | null>>;
    };
    try {
      index = JSON.parse(await fs.readFile(path.join(casDir, 'index.json'), 'utf-8'));
    } catch {
      return false; // missing or corrupt — nothing to load, never throws
    }

    // Blobs first: fileHistory refs and manifest refs both resolve against them.
    try {
      const blobNames = await fs.readdir(path.join(casDir, 'blobs'));
      for (const name of blobNames) {
        if (name.endsWith('.tmp')) continue;
        try {
          const content = await fs.readFile(path.join(casDir, 'blobs', name), 'utf-8');
          if (this.hashContent(content) !== name) continue; // corrupt/tampered blob
          this.blobs.set(name, content);
        } catch {
          // a single unreadable blob must not block the rest
        }
      }
    } catch {
      // no blobs dir yet
    }

    for (const manifest of index.manifests ?? []) {
      if (!manifest?.checkpointId) continue;
      this.manifests.set(manifest.checkpointId, manifest);
      const list = this.sessionCheckpoints.get(manifest.sessionId) ?? [];
      if (!list.includes(manifest.checkpointId)) list.push(manifest.checkpointId);
      list.sort((a, b) => (this.manifests.get(a)?.timestamp ?? 0) - (this.manifests.get(b)?.timestamp ?? 0));
      this.sessionCheckpoints.set(manifest.sessionId, list);
    }

    for (const [key, versions] of Object.entries(index.fileHistory ?? {})) {
      const resolved: Array<string | null> = [];
      for (const ref of versions) {
        if (ref === null) {
          resolved.push(null);
          continue;
        }
        const content = this.blobs.get(ref);
        if (content !== undefined) resolved.push(content);
        // blob missing (partial/corrupt state) → drop that entry rather than fail the load
      }
      if (resolved.length > 0) this.fileHistory.set(key, resolved);
    }

    return true;
  }

  /**
   * Boot-time housekeeping (call next to reconcileRunsOnBoot, before load):
   *   1. TTL — manifests older than CAS_TTL_MS (default 24h) are dropped from
   *      index.json (history itself is depth-capped and tiny, so it keeps no TTL).
   *   2. Orphan GC — when index.json is present and valid, every blob file
   *      referenced by neither a surviving manifest nor fileHistory is deleted.
   *      If index.json is missing or corrupt, permanent blobs are preserved and
   *      only stale *.tmp crash leftovers are cleaned up.
   * Operates directly on disk; does not require (or mutate) this store's state.
   */
  async pruneCasOnBoot(
    baseDir: string = process.cwd()
  ): Promise<{ removedManifests: number; removedBlobs: number }> {
    const casDir = path.resolve(baseDir, '.free-llm-mcp', 'cas');
    const indexPath = path.join(casDir, 'index.json');
    const result = { removedManifests: 0, removedBlobs: 0 };

    let index: {
      version?: number;
      manifests?: CheckpointManifest[];
      fileHistory?: Record<string, Array<string | null>>;
    } = { version: 1, manifests: [], fileHistory: {} };
    let hadIndex = false;
    let indexMissing = false;
    let indexCorrupt = false;
    try {
      const rawIndex = await fs.readFile(indexPath, 'utf-8');
      const parsed = JSON.parse(rawIndex);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('corrupt index');
      if (parsed.manifests !== undefined && !Array.isArray(parsed.manifests)) throw new Error('corrupt index');
      if (parsed.fileHistory !== undefined && (typeof parsed.fileHistory !== 'object' || parsed.fileHistory === null)) throw new Error('corrupt index');
      index = parsed;
      hadIndex = true;
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        indexMissing = true;
      } else {
        indexCorrupt = true;
      }
    }
    if (indexCorrupt) return result; // corrupt or unreadable index: abort GC entirely — never treat referenced blobs as orphans
    if (indexMissing) {
      // Missing index: only clean up uncommitted .tmp crash orphans if blobs dir exists, never touch permanent blobs
      try {
        const blobNames = await fs.readdir(path.join(casDir, 'blobs'));
        for (const name of blobNames) {
          if (name.endsWith('.tmp')) {
            await fs.remove(path.join(casDir, 'blobs', name)).catch(() => {});
            result.removedBlobs++;
          }
        }
      } catch {}
      return result;
    }

    const ttl = Number(process.env.CAS_TTL_MS) || 86_400_000;
    const cutoff = Date.now() - ttl;
    const all = index.manifests ?? [];
    const survivors = all.filter(m => (m?.timestamp ?? 0) >= cutoff);
    result.removedManifests = all.length - survivors.length;

    const referenced = new Set<string>();
    for (const m of survivors) {
      for (const hash of Object.values(m.files ?? {})) referenced.add(hash);
    }
    for (const versions of Object.values(index.fileHistory ?? {})) {
      for (const ref of versions) if (typeof ref === 'string') referenced.add(ref);
    }

    try {
      const blobNames = await fs.readdir(path.join(casDir, 'blobs'));
      for (const name of blobNames) {
        const isTmp = name.endsWith('.tmp');
        if (isTmp || !referenced.has(name)) {
          await fs.remove(path.join(casDir, 'blobs', name)).catch(() => {});
          result.removedBlobs++;
        }
      }
    } catch {
      // no blobs dir — nothing to GC
    }

    if (hadIndex && result.removedManifests > 0) {
      const tmpIndex = `${indexPath}.tmp`;
      await fs.writeFile(tmpIndex, JSON.stringify({ ...index, manifests: survivors }), 'utf-8');
      await fs.rename(tmpIndex, indexPath);
    }

    return result;
  }
}

// Global shared singleton instance for the MCP server process
export const globalCasStore = new ContentAddressableStore();
