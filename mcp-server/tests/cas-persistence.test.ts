/**
 * R2 — CAS disk persistence: flush / load / boot prune (TTL + orphan GC).
 *
 * Layout (opt-in via initCasPersistence(baseDir)):
 *   <baseDir>/.free-llm-mcp/cas/
 *     index.json          { version:1, manifests:[...], fileHistory:{key:[hash|null,...]} }
 *     blobs/<sha256>      one file per distinct content (immutable, content-addressed)
 *
 * Contract:
 *   initCasPersistence(baseDir) — sets the persistence dir (nothing on disk yet,
 *     no I/O happens until flush). Returns the resolved dir.
 *   flushCasToDisk() — true after atomically writing blobs + index.json;
 *     false when persistence was never initialized (no disk I/O at all).
 *   loadCasFromDisk() — true after hydrating memory from index.json + blobs;
 *     false when uninitialized or index.json missing/corrupt.
 *   pruneCasOnBoot(baseDir = cwd) — drops manifests older than CAS_TTL_MS
 *     (default 24h) from index.json and deletes orphan blobs (files on disk
 *     referenced by neither a surviving manifest nor fileHistory). Standalone:
 *     works on disk without initializing this store.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { ContentAddressableStore } from '../src/memory/ContentAddressableCheckpoint.js';

const TTL_25H = 25 * 60 * 60 * 1000; // older than the default 24h CAS_TTL_MS

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'omp-cas-persist-'));
}

function casDirOf(baseDir: string): string {
  return path.resolve(baseDir, '.free-llm-mcp', 'cas');
}

describe('ContentAddressableStore — disk persistence (R2)', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await makeTmpDir();
  });

  afterEach(async () => {
    if (baseDir) await fs.remove(baseDir);
    delete process.env.CAS_TTL_MS;
  });

  it('initCasPersistence resolves <baseDir>/.free-llm-mcp/cas and performs no I/O', async () => {
    const cas = new ContentAddressableStore();
    const dir = cas.initCasPersistence(baseDir);
    expect(dir).toBe(path.resolve(baseDir, '.free-llm-mcp', 'cas'));
    // init alone must not touch the filesystem
    expect(await fs.pathExists(dir)).toBe(false);
  });

  it('flush writes blobs + index.json atomically, with no .tmp leftovers', async () => {
    const cas = new ContentAddressableStore();
    cas.initCasPersistence(baseDir);
    const manifest = cas.createCheckpoint('sess-a', 'first checkpoint', {
      'src/a.ts': 'export const a = 1;',
    });

    await expect(cas.flushCasToDisk()).resolves.toBe(true);

    const dir = casDirOf(baseDir);
    const indexPath = path.join(dir, 'index.json');
    expect(await fs.pathExists(indexPath)).toBe(true);

    const blobPath = path.join(dir, 'blobs', manifest.files['src/a.ts']);
    expect(await fs.pathExists(blobPath)).toBe(true);
    expect(await fs.readFile(blobPath, 'utf-8')).toBe('export const a = 1;');

    const index = JSON.parse(await fs.readFile(indexPath, 'utf-8'));
    expect(index.version).toBe(1);
    expect(index.manifests).toHaveLength(1);
    expect(index.manifests[0].checkpointId).toBe(manifest.checkpointId);
    expect(index.manifests[0].files['src/a.ts']).toBe(manifest.files['src/a.ts']);

    const tmpLeftovers = (await fs.readdir(dir)).filter(f => f.endsWith('.tmp'));
    expect(tmpLeftovers).toEqual([]);

    // Repeated flush is idempotent (content-addressed blobs are skipped)
    await expect(cas.flushCasToDisk()).resolves.toBe(true);
    expect((await fs.readdir(dir)).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });

  it('load round-trips manifests, session order, blobs and fileHistory (incl. null slot)', async () => {
    const writer = new ContentAddressableStore();
    writer.initCasPersistence(baseDir);
    const m1 = writer.createCheckpoint('sess-a', 'one', { 'src/a.ts': 'v1 content' });
    const m2 = writer.createCheckpoint('sess-a', 'two', { 'src/a.ts': 'v2 content' });
    writer.createCheckpoint('sess-b', 'other session', { 'src/b.ts': 'b content' });
    const wsRoot = '/tmp/fake-workspace-for-history';
    writer.recordFileVersions(wsRoot, {
      'src/a.ts': 'v1 content',
      'src/new.ts': null,
    });
    await writer.flushCasToDisk();

    const reader = new ContentAddressableStore();
    reader.initCasPersistence(baseDir);
    await expect(reader.loadCasFromDisk()).resolves.toBe(true);

    // manifests + content
    expect(reader.getCheckpoint(m1.checkpointId)?.description).toBe('one');
    expect(reader.restoreCheckpointContent(m1.checkpointId)).toEqual({ 'src/a.ts': 'v1 content' });
    expect(reader.restoreCheckpointContent(m2.checkpointId)).toEqual({ 'src/a.ts': 'v2 content' });
    // session order preserved per session
    expect(reader.listSessionCheckpoints('sess-a').map(c => c.checkpointId))
      .toEqual([m1.checkpointId, m2.checkpointId]);
    expect(reader.listSessionCheckpoints('sess-b')).toHaveLength(1);
    // blobs readable directly
    expect(reader.getBlob(m1.files['src/a.ts'])).toBe('v1 content');
    // fileHistory round-trips raw content AND the null (did-not-exist) slot
    expect(reader.fileHistoryVersions(wsRoot, 'src/a.ts')).toEqual(['v1 content']);
    expect(reader.fileHistoryVersions(wsRoot, 'src/new.ts')).toEqual([null]);
  });

  it('flush/load are safe no-ops without initCasPersistence (no disk I/O)', async () => {
    const cas = new ContentAddressableStore();
    cas.createCheckpoint('sess-a', 'memory only', { 'src/a.ts': 'x' });

    await expect(cas.flushCasToDisk()).resolves.toBe(false);
    await expect(cas.loadCasFromDisk()).resolves.toBe(false);
    // in-memory state untouched
    expect(cas.getStats().totalCheckpoints).toBe(1);
    expect(await fs.pathExists(path.join(baseDir, '.free-llm-mcp'))).toBe(false);
  });

  it('load returns false when index.json does not exist', async () => {
    const cas = new ContentAddressableStore();
    cas.initCasPersistence(baseDir);
    await expect(cas.loadCasFromDisk()).resolves.toBe(false);
  });

  it('pruneCasOnBoot drops manifests older than CAS_TTL_MS (default 24h) and their blobs', async () => {
    // Build an index.json on disk by hand — the persisted format is the contract.
    const dir = casDirOf(baseDir);
    const blobsDir = path.join(dir, 'blobs');
    await fs.ensureDir(blobsDir);
    const probe = new ContentAddressableStore();
    const oldHash = probe.hashContent('old content');
    const freshHash = probe.hashContent('fresh content');
    await fs.writeFile(path.join(blobsDir, oldHash), 'old content', 'utf-8');
    await fs.writeFile(path.join(blobsDir, freshHash), 'fresh content', 'utf-8');
    await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({
      version: 1,
      manifests: [
        { checkpointId: 'chk-old', sessionId: 's', timestamp: Date.now() - TTL_25H,
          description: 'expired', files: { 'src/a.ts': oldHash } },
        { checkpointId: 'chk-fresh', sessionId: 's', timestamp: Date.now(),
          description: 'fresh', files: { 'src/a.ts': freshHash } },
      ],
      fileHistory: {},
    }), 'utf-8');

    const cas = new ContentAddressableStore();
    const result = await cas.pruneCasOnBoot(baseDir);
    expect(result.removedManifests).toBe(1);
    expect(result.removedBlobs).toBe(1);
    // expired blob gone, fresh blob kept
    expect(await fs.pathExists(path.join(blobsDir, oldHash))).toBe(false);
    expect(await fs.pathExists(path.join(blobsDir, freshHash))).toBe(true);

    // survivors hydrate into memory
    cas.initCasPersistence(baseDir);
    await expect(cas.loadCasFromDisk()).resolves.toBe(true);
    expect(cas.getCheckpoint('chk-old')).toBeUndefined();
    expect(cas.getCheckpoint('chk-fresh')?.description).toBe('fresh');
    expect(cas.restoreCheckpointContent('chk-fresh')).toEqual({ 'src/a.ts': 'fresh content' });
    expect(cas.listSessionCheckpoints('s').map(c => c.checkpointId)).toEqual(['chk-fresh']);
  });

  it('honors CAS_TTL_MS override when deciding expiry', async () => {
    const dir = casDirOf(baseDir);
    const blobsDir = path.join(dir, 'blobs');
    await fs.ensureDir(blobsDir);
    const probe = new ContentAddressableStore();
    const hash = probe.hashContent('two hours old');
    await fs.writeFile(path.join(blobsDir, hash), 'two hours old', 'utf-8');
    // 2h old: fresh under the default 24h TTL, expired under CAS_TTL_MS=1h
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({
      version: 1,
      manifests: [{ checkpointId: 'chk-2h', sessionId: 's', timestamp: twoHoursAgo,
        description: 'x', files: { 'src/a.ts': hash } }],
      fileHistory: {},
    }), 'utf-8');

    process.env.CAS_TTL_MS = String(60 * 60 * 1000);
    const cas = new ContentAddressableStore();
    const result = await cas.pruneCasOnBoot(baseDir);
    expect(result.removedManifests).toBe(1);
    expect(result.removedBlobs).toBe(1);
  });

  it('prune keeps blobs referenced by fileHistory and deletes true orphans', async () => {
    const dir = casDirOf(baseDir);
    const blobsDir = path.join(dir, 'blobs');
    await fs.ensureDir(blobsDir);
    const probe = new ContentAddressableStore();
    const historyHash = probe.hashContent('undo history only'); // referenced ONLY by fileHistory
    const orphanHash = probe.hashContent('nobody references me');
    await fs.writeFile(path.join(blobsDir, historyHash), 'undo history only', 'utf-8');
    await fs.writeFile(path.join(blobsDir, orphanHash), 'nobody references me', 'utf-8');
    const wsRoot = '/tmp/fake-ws-history-keep';
    await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({
      version: 1,
      manifests: [],
      fileHistory: { [`${wsRoot}\u0000src/f.ts`]: [historyHash] },
    }), 'utf-8');

    const cas = new ContentAddressableStore();
    const result = await cas.pruneCasOnBoot(baseDir);
    expect(result.removedManifests).toBe(0);
    expect(result.removedBlobs).toBe(1);
    expect(await fs.pathExists(path.join(blobsDir, historyHash))).toBe(true);
    expect(await fs.pathExists(path.join(blobsDir, orphanHash))).toBe(false);

    // history content still round-trips after prune
    cas.initCasPersistence(baseDir);
    await expect(cas.loadCasFromDisk()).resolves.toBe(true);
    expect(cas.fileHistoryVersions(wsRoot, 'src/f.ts')).toEqual(['undo history only']);
  });

  it('prune with no index.json removes leftover blobs (crash orphans)', async () => {
    const dir = casDirOf(baseDir);
    const blobsDir = path.join(dir, 'blobs');
    await fs.ensureDir(blobsDir);
    await fs.writeFile(path.join(blobsDir, 'deadbeef'.repeat(8)), 'orphan', 'utf-8');

    const cas = new ContentAddressableStore();
    const result = await cas.pruneCasOnBoot(baseDir);
    expect(result.removedBlobs).toBe(1);
    expect((await fs.readdir(blobsDir)).length).toBe(0);
  });
});
