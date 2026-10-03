/**
 * R1 — Per-file rollback depth 3 (fileHistory ring buffer).
 *
 * Store contract:
 *   recordFileVersions(wsRoot, {relPath: content|null})  — records the PRE-apply
 *     version of each file; null = the file did not exist yet (new-file create).
 *     Ring buffer per (wsRoot, relPath), newest first, capped at
 *     CAS_FILE_HISTORY_DEPTH (default 3) — oldest evicted.
 *   fileHistoryVersions(wsRoot, relPath) — newest-first snapshot, read-only.
 *   undoFileVersionToDisk(wsRoot, relPath) — pops the newest version and restores
 *     it atomically (tmp+rename; null slot deletes the file), path-guarded to
 *     stay inside wsRoot. Throws `No more history` when the buffer is empty.
 *
 * Handler contract (resolve actions):
 *   {action:'undo_file', filePath}    → restores, returns {restored, remainingDepth}
 *   {action:'file_history', filePath} → read-only list of versions
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { ContentAddressableStore } from '../src/memory/ContentAddressableCheckpoint.js';
import { CodingAgentsHandler } from '../src/tools/coding-agents.js';

async function makeTmpWorkspace(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-cas-history-'));
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(dir, relPath);
    await fs.ensureDir(path.dirname(abs));
    await fs.writeFile(abs, content, 'utf-8');
  }
  return dir;
}

describe('ContentAddressableStore — per-file history ring buffer', () => {
  let cas: ContentAddressableStore;
  let ws: string;

  beforeEach(async () => {
    cas = new ContentAddressableStore();
    ws = await makeTmpWorkspace({ 'src/f.ts': 'seed' });
  });

  afterEach(async () => {
    if (ws) await fs.remove(ws);
  });

  it('caps history at 3 entries (CAS_FILE_HISTORY_DEPTH default), newest first', () => {
    cas.recordFileVersions(ws, { 'src/f.ts': 'v1' });
    cas.recordFileVersions(ws, { 'src/f.ts': 'v2' });
    cas.recordFileVersions(ws, { 'src/f.ts': 'v3' });
    cas.recordFileVersions(ws, { 'src/f.ts': 'v4' }); // evicts v1

    expect(cas.fileHistoryVersions(ws, 'src/f.ts')).toEqual(['v4', 'v3', 'v2']);
  });

  it('records a null slot for files that did not exist before the apply', () => {
    cas.recordFileVersions(ws, { 'src/f.ts': 'existing', 'src/new.ts': null });

    expect(cas.fileHistoryVersions(ws, 'src/f.ts')).toEqual(['existing']);
    expect(cas.fileHistoryVersions(ws, 'src/new.ts')).toEqual([null]);
  });

  it('keys history per workspace root and per file', () => {
    const other = path.join(path.dirname(ws), 'omp-cas-history-other');
    cas.recordFileVersions(ws, { 'src/f.ts': 'ws1' });
    cas.recordFileVersions(other, { 'src/f.ts': 'ws2' });
    cas.recordFileVersions(ws, { 'src/g.ts': 'g1' });

    expect(cas.fileHistoryVersions(ws, 'src/f.ts')).toEqual(['ws1']);
    expect(cas.fileHistoryVersions(other, 'src/f.ts')).toEqual(['ws2']);
    expect(cas.fileHistoryVersions(ws, 'src/g.ts')).toEqual(['g1']);
  });

  it('undo pops newest-first and throws "No more history" once drained', async () => {
    const rel = 'src/f.ts';
    // Disk currently holds v4; history holds pre-apply versions v3, v2, v1.
    await fs.writeFile(path.join(ws, rel), 'v4', 'utf-8');
    cas.recordFileVersions(ws, { [rel]: 'v1' });
    cas.recordFileVersions(ws, { [rel]: 'v2' });
    cas.recordFileVersions(ws, { [rel]: 'v3' });

    const first = await cas.undoFileVersionToDisk(ws, rel);
    expect(first).toEqual({ restored: true, remainingDepth: 2 });
    expect(await fs.readFile(path.join(ws, rel), 'utf-8')).toBe('v3');

    const second = await cas.undoFileVersionToDisk(ws, rel);
    expect(second.remainingDepth).toBe(1);
    expect(await fs.readFile(path.join(ws, rel), 'utf-8')).toBe('v2');

    const third = await cas.undoFileVersionToDisk(ws, rel);
    expect(third.remainingDepth).toBe(0);
    expect(await fs.readFile(path.join(ws, rel), 'utf-8')).toBe('v1');

    await expect(cas.undoFileVersionToDisk(ws, rel)).rejects.toThrow('No more history');
    // The failed undo must not corrupt the file or the buffer.
    expect(await fs.readFile(path.join(ws, rel), 'utf-8')).toBe('v1');
  });

  it('undo of a null slot deletes the newly-created file', async () => {
    const rel = 'src/brand-new.ts';
    await fs.ensureDir(path.dirname(path.join(ws, rel)));
    await fs.writeFile(path.join(ws, rel), 'created by apply', 'utf-8');
    cas.recordFileVersions(ws, { [rel]: null }); // did not exist pre-apply

    const out = await cas.undoFileVersionToDisk(ws, rel);
    expect(out).toEqual({ restored: true, remainingDepth: 0 });
    expect(await fs.pathExists(path.join(ws, rel))).toBe(false);
  });

  it('rejects path traversal outside the workspace', async () => {
    cas.recordFileVersions(ws, { '../escape.ts': 'evil' });
    await expect(cas.undoFileVersionToDisk(ws, '../escape.ts'))
      .rejects.toThrow(/invalid relative path/);
  });
});

describe('CodingAgentsHandler — resolve undo_file / file_history', () => {
  let ws: string;

  beforeEach(async () => {
    ws = await makeTmpWorkspace({ 'src/versioned.ts': "export const marker = 'v1';" });
  });

  afterEach(async () => {
    if (ws) await fs.remove(ws);
  });

  const applyVersion = (from: string, to: string) => CodingAgentsHandler({
    goal: `change ${from} to ${to}`,
    workspaceRoot: ws,
    dryRun: false,
    topKFiles: 10,
    astEditOps: [{ pat: from, out: to }],
    resolve: { action: 'apply' },
  });

  const readMarker = async () => {
    const content = await fs.readFile(path.join(ws, 'src/versioned.ts'), 'utf-8');
    return content.match(/'([^']+)'/)?.[1];
  };

  it('records history on apply; file_history lists v3..v1; 3 undos walk back to v1, then "No more history"', async () => {
    const a1 = await applyVersion('v1', 'v2');
    expect(a1.applied).toBe(true);
    const a2 = await applyVersion('v2', 'v3');
    const a3 = await applyVersion('v3', 'v4');
    expect(a3.applied).toBe(true);
    expect(await readMarker()).toBe('v4');

    // Read-only history: newest first, includes the original v1.
    const hist = await CodingAgentsHandler({
      goal: 'inspect history',
      workspaceRoot: ws,
      resolve: { action: 'file_history', filePath: 'src/versioned.ts' },
    });
    expect(hist.error).toBeUndefined();
    expect(hist.fileHistory).toEqual([
      "export const marker = 'v3';",
      "export const marker = 'v2';",
      "export const marker = 'v1';",
    ]);

    // undo #1 → v3
    const u1 = await CodingAgentsHandler({
      goal: 'undo',
      workspaceRoot: ws,
      resolve: { action: 'undo_file', filePath: 'src/versioned.ts' },
    });
    expect(u1.error).toBeUndefined();
    expect(u1.restored).toBe(true);
    expect(u1.remainingDepth).toBe(2);
    expect(await readMarker()).toBe('v3');

    // undo #2 → v2
    const u2 = await CodingAgentsHandler({
      goal: 'undo',
      workspaceRoot: ws,
      resolve: { action: 'undo_file', filePath: 'src/versioned.ts' },
    });
    expect(u2.error).toBeUndefined();
    expect(u2.remainingDepth).toBe(1);
    expect(await readMarker()).toBe('v2');

    // undo #3 → v1 (back to the original state)
    const u3 = await CodingAgentsHandler({
      goal: 'undo',
      workspaceRoot: ws,
      resolve: { action: 'undo_file', filePath: 'src/versioned.ts' },
    });
    expect(u3.error).toBeUndefined();
    expect(u3.remainingDepth).toBe(0);
    expect(await readMarker()).toBe('v1');

    // undo #4 → drained: clear error, file untouched
    const u4 = await CodingAgentsHandler({
      goal: 'undo',
      workspaceRoot: ws,
      resolve: { action: 'undo_file', filePath: 'src/versioned.ts' },
    });
    expect(u4.error).toContain('No more history');
    expect(await readMarker()).toBe('v1');
  });

  it('a 4th apply evicts the oldest version (depth-3 cap): 3 undos restore v4..v2 only', async () => {
    await applyVersion('v1', 'v2');
    await applyVersion('v2', 'v3');
    await applyVersion('v3', 'v4');
    await applyVersion('v4', 'v5'); // pushes v4, evicts v1
    expect(await readMarker()).toBe('v5');

    const hist = await CodingAgentsHandler({
      goal: 'inspect history',
      workspaceRoot: ws,
      resolve: { action: 'file_history', filePath: 'src/versioned.ts' },
    });
    expect(hist.error).toBeUndefined();
    expect(hist.fileHistory).toEqual([
      "export const marker = 'v4';",
      "export const marker = 'v3';",
      "export const marker = 'v2';",
    ]);

    const u1 = await CodingAgentsHandler({
      goal: 'undo',
      workspaceRoot: ws,
      resolve: { action: 'undo_file', filePath: 'src/versioned.ts' },
    });
    expect(u1.restored).toBe(true);
    expect(await readMarker()).toBe('v4');

    const u2 = await CodingAgentsHandler({
      goal: 'undo',
      workspaceRoot: ws,
      resolve: { action: 'undo_file', filePath: 'src/versioned.ts' },
    });
    expect(u2.remainingDepth).toBe(1);
    expect(await readMarker()).toBe('v3');

    const u3 = await CodingAgentsHandler({
      goal: 'undo',
      workspaceRoot: ws,
      resolve: { action: 'undo_file', filePath: 'src/versioned.ts' },
    });
    expect(u3.remainingDepth).toBe(0);
    expect(await readMarker()).toBe('v2');

    // v1 was evicted — depth 3 is a hard limit
    const u4 = await CodingAgentsHandler({
      goal: 'undo',
      workspaceRoot: ws,
      resolve: { action: 'undo_file', filePath: 'src/versioned.ts' },
    });
    expect(u4.error).toContain('No more history');
    expect(await readMarker()).toBe('v2');
  });

  it('undo_file without resolve.filePath fails with a clear error', async () => {
    const res = await CodingAgentsHandler({
      goal: 'undo',
      workspaceRoot: ws,
      resolve: { action: 'undo_file' },
    });
    expect(res.error).toContain('filePath');
  });
});
