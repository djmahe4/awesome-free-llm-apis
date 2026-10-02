import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { ReasoningScopeRegistry } from '../src/harness/scope-registry.js';

describe('ReasoningScopeRegistry & Context Relay', () => {
  let tmpDir: string;
  let registry: ReasoningScopeRegistry;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reasoning-scope-test-'));
    registry = new ReasoningScopeRegistry(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('detects keyword collision between subagents and relays weighted context', async () => {
    await registry.registerReasoningScope({
      runId: 'run-1',
      agentId: 'researcher-1',
      role: 'researcher',
      keywords: ['jwt', 'token', 'auth', 'expiration'],
      findingsText: `Examined authentication layer.\nJWT secret is hardcoded in auth.config.\nToken expiration is not enforced on refresh endpoints.\nUser profile avatar loads via S3.`
    });

    const collisionResult = await registry.checkAndRelayReasoningContext({
      runId: 'run-1',
      agentId: 'analyst-1',
      role: 'analyst',
      keywords: ['jwt', 'vulnerability', 'token'],
      maxTokens: 500
    });

    expect(collisionResult.hasOverlap).toBe(true);
    expect(collisionResult.overlappingKeywords).toContain('jwt');
    expect(collisionResult.overlappingKeywords).toContain('token');
    expect(collisionResult.relayedContext).toContain('JWT secret is hardcoded');
    expect(collisionResult.relayedContext).toContain('Token expiration is not enforced');
    expect(collisionResult.relayedContext).not.toContain('User profile avatar');
  });

  it('calculates weighted lines ordered by keyword match density', async () => {
    await registry.registerReasoningScope({
      runId: 'run-1',
      agentId: 'agent-a',
      role: 'researcher',
      keywords: ['database', 'query', 'postgres', 'index'],
      findingsText: `Line with one match: postgres.\nLine with three matches: postgres database query index is fast.\nIrrelevant text here.`
    });

    const res = await registry.checkAndRelayReasoningContext({
      runId: 'run-1',
      agentId: 'agent-b',
      role: 'coder',
      keywords: ['database', 'query', 'index'],
      maxTokens: 50
    });

    const lines = res.relayedContext.split('\n');
    expect(lines[0]).toContain('Line with three matches');
  });
});
