import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import type { HarnessRun } from '../src/harness/types.js';

// P4 plan's own self-review point, never implemented until now: a run.json
// left 'running' by a server crash/restart looked identical to one still
// legitimately in progress. reconcileRunsOnBoot marks every such run
// 'failed' with a clear reason, so a status query stops reporting
// "running" forever for something nobody is actually working on anymore.

describe('reconcileRunsOnBoot', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-boot-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  function baseRun(overrides: Partial<HarnessRun> = {}): HarnessRun {
    return {
      runId: 'r1', harness: 'h', declarationName: 'h', goal: 'g', status: 'running',
      budget: { maxTokens: 1000, used: 0, reserved: 0, toolCalls: 0 },
      createdAt: Date.now(), updatedAt: Date.now(),
      ...overrides,
    };
  }

  it('marks a running run failed with an orphaned reason', async () => {
    const { HarnessStore } = await import('../src/harness/store.js');
    const { reconcileRunsOnBoot } = await import('../src/harness/store.js');

    const store = new HarnessStore('r1', tmpDir);
    await store.saveRun(baseRun());

    const reconciled = await reconcileRunsOnBoot(tmpDir);
    expect(reconciled).toEqual([{ runId: 'r1' }]);

    const after = await store.loadRun();
    expect(after?.status).toBe('failed');
    expect(after?.error).toContain('Orphaned on restart');

    const events = await store.readTrace();
    expect(events.some(e => e.type === 'error' && (e.data as any).message?.includes('Orphaned on restart'))).toBe(true);
  });

  it('leaves a non-running run (complete/paused_approval/failed) untouched', async () => {
    const { HarnessStore, reconcileRunsOnBoot } = await import('../src/harness/store.js');

    const completeStore = new HarnessStore('r2', tmpDir);
    await completeStore.saveRun(baseRun({ runId: 'r2', status: 'complete' }));
    const pausedStore = new HarnessStore('r3', tmpDir);
    await pausedStore.saveRun(baseRun({ runId: 'r3', status: 'paused_approval' }));

    const reconciled = await reconcileRunsOnBoot(tmpDir);
    expect(reconciled).toEqual([]);

    expect((await completeStore.loadRun())?.status).toBe('complete');
    expect((await pausedStore.loadRun())?.status).toBe('paused_approval');
  });

  it('reconciles multiple orphaned runs under the same baseDir independently', async () => {
    const { HarnessStore, reconcileRunsOnBoot } = await import('../src/harness/store.js');

    const s1 = new HarnessStore('multi-1', tmpDir);
    const s2 = new HarnessStore('multi-2', tmpDir);
    await s1.saveRun(baseRun({ runId: 'multi-1' }));
    await s2.saveRun(baseRun({ runId: 'multi-2', status: 'complete' }));

    const reconciled = await reconcileRunsOnBoot(tmpDir);
    expect(reconciled).toEqual([{ runId: 'multi-1' }]);
    expect((await s1.loadRun())?.status).toBe('failed');
    expect((await s2.loadRun())?.status).toBe('complete');
  });

  it('returns an empty list when the harness directory does not exist yet — never throws', async () => {
    const { reconcileRunsOnBoot } = await import('../src/harness/store.js');
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-boot-empty-'));
    try {
      const reconciled = await reconcileRunsOnBoot(emptyDir);
      expect(reconciled).toEqual([]);
    } finally {
      await fs.remove(emptyDir);
    }
  });

  it('a malformed run.json for one runId does not block reconciling the rest', async () => {
    const { HarnessStore, reconcileRunsOnBoot } = await import('../src/harness/store.js');

    const goodStore = new HarnessStore('good-1', tmpDir);
    await goodStore.saveRun(baseRun({ runId: 'good-1' }));

    const badDir = path.join(tmpDir, '.free-llm-mcp', 'harness', 'bad-1');
    await fs.ensureDir(badDir);
    await fs.writeFile(path.join(badDir, 'run.json'), '{ not valid json', 'utf-8');

    const reconciled = await reconcileRunsOnBoot(tmpDir);
    expect(reconciled).toEqual([{ runId: 'good-1' }]);
    expect((await goodStore.loadRun())?.status).toBe('failed');
  });
});
