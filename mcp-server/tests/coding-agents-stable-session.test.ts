/**
 * R3 — stable workspace session identity.
 *
 * The sessionId fallback used to be `omp-${Date.now()}`, so every call that
 * omitted sessionId started a fresh session and fragmented CAS history.
 * It must now be deterministic per workspace: same workspace => same sessionId,
 * different workspace => different sessionId, and file alterations must never
 * cause the session to rotate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { CodingAgentsHandler } from '../src/tools/coding-agents.js';

async function makeTmpWorkspace(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('CodingAgentsHandler — stable workspace sessionId', () => {
  let ws1: string;
  let ws2: string;

  beforeEach(async () => {
    ws1 = await makeTmpWorkspace('omp-sess-ws1-');
    ws2 = await makeTmpWorkspace('omp-sess-ws2-');
    await fs.writeFile(path.join(ws1, 'a.ts'), 'export const a = 1;\n', 'utf-8');
    await fs.writeFile(path.join(ws2, 'b.ts'), 'export const b = 2;\n', 'utf-8');
  });

  afterEach(async () => {
    if (ws1) await fs.remove(ws1);
    if (ws2) await fs.remove(ws2);
  });

  it('derives the same sessionId across calls on one workspace when sessionId is omitted', async () => {
    const r1 = await CodingAgentsHandler({
      goal: 'inspect a',
      workspaceRoot: ws1,
      dryRun: true,
      topKFiles: 1,
      verifyLspDiagnostics: false,
    });
    const r2 = await CodingAgentsHandler({
      goal: 'inspect a again',
      workspaceRoot: ws1,
      dryRun: true,
      topKFiles: 1,
      verifyLspDiagnostics: false,
    });

    expect(r1.sessionId).toMatch(/^omp-ws-/);
    expect(r2.sessionId).toBe(r1.sessionId);
  });

  it('does not rotate the sessionId after a file alteration', async () => {
    const plan = await CodingAgentsHandler({
      goal: 'add comment to a',
      workspaceRoot: ws1,
      dryRun: false,
      topKFiles: 1,
      verifyLspDiagnostics: false,
      astEditOps: [{ pat: 'export const a = 1;', out: '/** one */\nexport const a = 1;' }],
      resolve: { action: 'apply' },
    });
    expect(plan.applied).toBe(true);

    const after = await CodingAgentsHandler({
      goal: 'verify a',
      workspaceRoot: ws1,
      dryRun: true,
      topKFiles: 1,
      verifyLspDiagnostics: false,
    });
    expect(after.sessionId).toBe(plan.sessionId);
  });

  it('derives different sessionIds for different workspaces', async () => {
    const r1 = await CodingAgentsHandler({
      goal: 'inspect',
      workspaceRoot: ws1,
      dryRun: true,
      topKFiles: 1,
      verifyLspDiagnostics: false,
    });
    const r2 = await CodingAgentsHandler({
      goal: 'inspect',
      workspaceRoot: ws2,
      dryRun: true,
      topKFiles: 1,
      verifyLspDiagnostics: false,
    });

    expect(r1.sessionId).not.toBe(r2.sessionId);
  });

  it('keeps the canonical workspace-derived sessionId even when a caller sessionId is supplied', async () => {
    const r = await CodingAgentsHandler({
      goal: 'inspect',
      workspaceRoot: ws1,
      dryRun: true,
      topKFiles: 1,
      verifyLspDiagnostics: false,
      sessionId: 'my-fixed-session',
    });
    // fallback to the workspace session happened — caller id is not the result
    expect(r.sessionId).not.toBe('my-fixed-session');
    expect(r.sessionId).toMatch(/^omp-ws-/);
    // ...and equals the derivation without an explicit id at all.
    const r2 = await CodingAgentsHandler({
      goal: 'inspect again',
      workspaceRoot: ws1,
      dryRun: true,
      topKFiles: 1,
      verifyLspDiagnostics: false,
    });
    expect(r.sessionId).toBe(r2.sessionId);
  });

  it('preserves an explicit sessionId as an in-memory alias for polling without workspaceRoot', async () => {
    const r = await CodingAgentsHandler({
      goal: 'inspect',
      workspaceRoot: ws1,
      dryRun: true,
      topKFiles: 1,
      verifyLspDiagnostics: false,
      sessionId: 'poll-with-my-id',
    });
    const canonical = r.sessionId;
    expect(canonical).toMatch(/^omp-ws-/);

    // status call carrying ONLY the original caller id (no workspaceRoot):
    // the alias must resolve it to the canonical session rather than falling
    // back to the cwd-derived hash.
    const status = await CodingAgentsHandler({
      goal: 'poll',
      sessionId: 'poll-with-my-id',
      action: 'status',
    });
    expect(status.sessionId).toBe(canonical);

    // the returned canonical id self-resolves too
    const status2 = await CodingAgentsHandler({ goal: 'poll', sessionId: canonical, action: 'status' });
    expect(status2.sessionId).toBe(canonical);
  });
});
