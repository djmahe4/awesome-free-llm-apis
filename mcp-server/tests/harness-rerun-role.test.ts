import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { HarnessStore } from '../src/harness/store.js';
import { reorchestrateRole } from '../src/harness/runner.js';
import type { HarnessRun } from '../src/harness/types.js';
import { waitForSettled } from './helpers/wait-for-run.js';

describe('Selective Role Reorchestration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rerun-role-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('allows rerunning a specific role from a complete run without discarding prior steps', async () => {
    const runId = 'complete-run-1';
    const store = new HarnessStore(runId, tmpDir);
    const run: HarnessRun = {
      runId,
      harness: 'Research & Analysis',
      declarationName: 'research-analysis',
      goal: 'Audit system performance',
      workspaceRoot: tmpDir,
      status: 'complete',
      budget: { maxTokens: 10000, used: 2000, reserved: 0, toolCalls: 2 },
      createdAt: Date.now() - 5000,
      updatedAt: Date.now() - 1000,
    };
    await store.saveRun(run);
    await store.saveTasksMarkdown('# Tasks\n- [x] researcher\n- [x] analyst\n');

    const updated = await reorchestrateRole({
      runId,
      role: 'analyst',
      workspaceRoot: tmpDir,
      followupContext: 'Focus on database bottleneck findings'
    });

    expect(updated.status).toBe('running');
    const tasks = await store.loadTasksMarkdown();
    expect(tasks).toContain('- [ ] analyst');
    expect(tasks).toContain('- [x] researcher');

    await waitForSettled(store, 10000);
  });
});
