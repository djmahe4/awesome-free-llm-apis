/**
 * Comprehensive integration tests for OMP ContentAddressableCheckpoint (CAS)
 * and Atomic Multi-File Single Update with Rollback.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { ContentAddressableStore, globalCasStore } from '../src/memory/ContentAddressableCheckpoint.js';
import { CodingAgentsHandler } from '../src/tools/coding-agents.js';

async function makeTmpWorkspace(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-cas-test-'));
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(dir, relPath);
    await fs.ensureDir(path.dirname(abs));
    await fs.writeFile(abs, content, 'utf-8');
  }
  return dir;
}

describe('ContentAddressableStore (CAS Deduplication & Checkpoints)', () => {
  let cas: ContentAddressableStore;

  beforeEach(() => {
    cas = new ContentAddressableStore();
  });

  it('deduplicates identical file contents (zero extra bytes stored for shared blobs)', () => {
    const commonContent = 'export function helper() { return 42; }';
    const hash1 = cas.putBlob(commonContent);
    const hash2 = cas.putBlob(commonContent);

    expect(hash1).toBe(hash2);
    expect(cas.getStats().totalBlobs).toBe(1);
    expect(cas.getBlob(hash1)).toBe(commonContent);
  });

  it('creates space-efficient checkpoint manifests across multiple files', () => {
    const manifest = cas.createCheckpoint('sess-1', 'Initial state', {
      'src/a.ts': 'const a = 1;',
      'src/b.ts': 'const b = 2;',
      'src/c.ts': 'const a = 1;', // identical content to a.ts -> deduplicated in CAS
    });

    expect(manifest.checkpointId).toContain('sess-1');
    expect(Object.keys(manifest.files)).toHaveLength(3);
    // src/a.ts and src/c.ts share the same content hash
    expect(manifest.files['src/a.ts']).toBe(manifest.files['src/c.ts']);
    expect(cas.getStats().totalBlobs).toBe(2); // only 2 unique blobs stored for 3 files
  });

  it('restores checkpoint content accurately', () => {
    const manifest = cas.createCheckpoint('sess-2', 'Baseline', {
      'config/app.json': '{"port": 8080}',
      'src/main.ts': 'console.log("start");',
    });

    const restored = cas.restoreCheckpointContent(manifest.checkpointId);
    expect(restored).toBeDefined();
    expect(restored?.['config/app.json']).toBe('{"port": 8080}');
    expect(restored?.['src/main.ts']).toBe('console.log("start");');
  });
});

describe('CodingAgentsHandler — OMP Multi-File Atomic Update & CAS Rollback', () => {
  let ws: string;

  beforeEach(async () => {
    ws = await makeTmpWorkspace({
      'src/service.ts': 'export function run() { legacyLogger("running"); }',
      'src/worker.ts': 'export function work() { legacyLogger("working"); }',
      'package.json': '{"name": "omp-test-pkg"}',
    });
  });

  afterEach(async () => {
    if (ws) await fs.remove(ws);
  });

  it('performs atomic multi-file apply and automatically captures a pre-apply CAS checkpoint', async () => {
    const result = await CodingAgentsHandler({
      goal: 'migrate legacyLogger across service and worker',
      workspaceRoot: ws,
      dryRun: false,
      topKFiles: 2,
      astEditOps: [
        { pat: 'legacyLogger($$$MSG)', out: 'logger.info($$$MSG)' },
      ],
      resolve: { action: 'apply' },
    });

    expect(result.applied).toBe(true);
    expect(result.checkpointId).toBeDefined();
    expect(result.checkpointId).toMatch(/^chk-omp-/);

    // Verify both files were updated atomically on disk
    const serviceContent = await fs.readFile(path.join(ws, 'src/service.ts'), 'utf-8');
    const workerContent = await fs.readFile(path.join(ws, 'src/worker.ts'), 'utf-8');
    expect(serviceContent).toContain('logger.info("running")');
    expect(workerContent).toContain('logger.info("working")');

    // ── Now test OMP instant CAS Rollback ──
    const rollbackResult = await CodingAgentsHandler({
      goal: 'rollback changes',
      workspaceRoot: ws,
      sessionId: result.sessionId,
      resolve: {
        action: 'rollback',
        checkpointId: result.checkpointId,
      },
    });

    expect(rollbackResult.applied).toBe(true);
    expect(rollbackResult.restoredFiles?.length).toBeGreaterThan(0);

    // Verify files on disk were reverted back to original pre-apply state
    const revertedService = await fs.readFile(path.join(ws, 'src/service.ts'), 'utf-8');
    const revertedWorker = await fs.readFile(path.join(ws, 'src/worker.ts'), 'utf-8');
    expect(revertedService).toContain('legacyLogger("running")');
    expect(revertedWorker).toContain('legacyLogger("working")');
  });
});
