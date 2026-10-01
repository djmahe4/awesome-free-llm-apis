import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { FileScopeRegistry, ReasoningScopeRegistry } from '../src/harness/scope-registry.js';

describe('Multiagent Interlock & Scope Protection', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'multiagent-interlock-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('prevents file collisions while passing reasoning findings between agents', async () => {
    const fileRegistry = new FileScopeRegistry(tmpDir);
    const reasoningRegistry = new ReasoningScopeRegistry(tmpDir);

    // Agent 1 claims auth.ts and registers reasoning findings
    const claim1 = await fileRegistry.acquireScope({ runId: 'run-1', agentId: 'agent-1', files: ['auth.ts'] });
    expect(claim1.acquired).toBe(true);

    await reasoningRegistry.registerReasoningScope({
      runId: 'run-1',
      agentId: 'agent-1',
      role: 'security_auditor',
      keywords: ['auth', 'crypto', 'session'],
      findingsText: 'Discovered weak HMAC secret in auth.ts session management.'
    });

    // Agent 2 attempts to work on same file without handoff -> blocked
    const claim2 = await fileRegistry.acquireScope({ runId: 'run-1', agentId: 'agent-2', files: ['auth.ts'] });
    expect(claim2.acquired).toBe(false);

    // Agent 2 checks reasoning context -> receives Agent 1's findings
    const contextRelay = await reasoningRegistry.checkAndRelayReasoningContext({
      runId: 'run-1',
      agentId: 'agent-2',
      role: 'analyst',
      keywords: ['auth', 'crypto']
    });

    expect(contextRelay.hasOverlap).toBe(true);
    expect(contextRelay.relayedContext).toContain('Discovered weak HMAC secret');

    // Agent 1 releases lock
    await fileRegistry.releaseScope('run-1', 'agent-1');

    // Agent 2 can now claim lock
    const claim2Retry = await fileRegistry.acquireScope({ runId: 'run-1', agentId: 'agent-2', files: ['auth.ts'] });
    expect(claim2Retry.acquired).toBe(true);
  });
});
