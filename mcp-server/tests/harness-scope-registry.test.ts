import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { FileScopeRegistry } from '../src/harness/scope-registry.js';

describe('FileScopeRegistry', () => {
  let tmpDir: string;
  let registry: FileScopeRegistry;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scope-reg-test-'));
    registry = new FileScopeRegistry(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('claims files for agent and detects collisions', async () => {
    const claim1 = await registry.acquireScope({
      runId: 'run-1',
      agentId: 'coder-1',
      files: ['src/services/auth.ts', 'src/models/user.ts']
    });
    expect(claim1.acquired).toBe(true);

    const claim2 = await registry.acquireScope({
      runId: 'run-2',
      agentId: 'coder-2',
      files: ['src/services/auth.ts']
    });
    expect(claim2.acquired).toBe(false);
    expect(claim2.conflicts).toContain('src/services/auth.ts');
  });

  it('releases files on completion', async () => {
    await registry.acquireScope({
      runId: 'run-1',
      agentId: 'coder-1',
      files: ['src/services/auth.ts']
    });
    await registry.releaseScope('run-1', 'coder-1');

    const claim2 = await registry.acquireScope({
      runId: 'run-2',
      agentId: 'coder-2',
      files: ['src/services/auth.ts']
    });
    expect(claim2.acquired).toBe(true);
  });
});
