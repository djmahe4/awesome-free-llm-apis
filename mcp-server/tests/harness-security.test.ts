import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { evaluate } from '../src/harness/policy.js';
import { HarnessStore } from '../src/harness/store.js';
import { agentHarness } from '../src/tools/agent-harness.js';
import { clampRunTokens } from '../src/harness/runner.js';
import type { HarnessDeclaration } from '../src/harness/types.js';

const decl = (extra: Partial<HarnessDeclaration> = {}): HarnessDeclaration => ({
  harness: {
    name: 'sec-test', schemaVersion: 1, primaryLane: 'x',
    budget: { maxTokens: 1000, maxToolCalls: 10, maxWallMinutes: 5, supervisorShareMax: 0.2 },
    approval: { timeoutMinutes: 5, standingRules: [] },
  },
  roles: {
    dev: { tools: [{ tool: 'coding_agents' }, { tool: 'local_llm_patch' }, { tool: 'cyber_tool', actions: ['run_action'] }] },
  },
  writes: [],
  contentDepth: { order: [], default: 'prompt' },
  handoff: { schemaVersion: 1, lowConfidenceThreshold: 0.5, maxDepth: 3 },
  ...extra,
} as HarnessDeclaration);

describe('policy: cyber_tool run_action must name its bridge', () => {
  it('an omitted bridge needs approval even when exactly one is listed (the project controls bridges.json, so the runtime could pick a different one)', () => {
    const d = decl({ cyberTools: ['katana'] });
    expect(evaluate(d, 'dev', 'cyber_tool', 'run_action', {}).kind).toBe('needs_approval');
  });
  it('an explicit listed bridge is allowed, an unlisted one is not', () => {
    const d = decl({ cyberTools: ['katana'] });
    expect(evaluate(d, 'dev', 'cyber_tool', 'run_action', { bridge: 'katana' }).kind).toBe('allow');
    expect(evaluate(d, 'dev', 'cyber_tool', 'run_action', { bridge: 'shell' }).kind).toBe('needs_approval');
  });
});

describe('policy: code-editing tools are always gated (as the tool description promises)', () => {
  it('coding_agents and local_llm_patch need approval even when the role allowlists them', () => {
    const d = decl();
    expect(evaluate(d, 'dev', 'coding_agents', undefined, { goal: 'x', dryRun: false, resolve: { action: 'apply' } }).kind).toBe('needs_approval');
    expect(evaluate(d, 'dev', 'coding_agents', 'execute', { goal: 'x', dryRun: false }).kind).toBe('needs_approval');
    expect(evaluate(d, 'dev', 'local_llm_patch', undefined, { filePath: 'a.ts', instruction: 'x' }).kind).toBe('needs_approval');
  });
  it('a standing allow rule in `writes` does not lift the gate either', () => {
    const d = decl({ writes: [{ tool: 'coding_agents' }] as any });
    expect(evaluate(d, 'dev', 'coding_agents', undefined, { goal: 'x', dryRun: false }).kind).toBe('needs_approval');
  });
  it('read-only coding_agents calls (status, abort, dry-run preview) still follow the role allowlist', () => {
    const d = decl();
    expect(evaluate(d, 'dev', 'coding_agents', 'status', { action: 'status' }).kind).toBe('allow');
    expect(evaluate(d, 'dev', 'coding_agents', 'abort', { action: 'abort' }).kind).toBe('allow');
    expect(evaluate(d, 'dev', 'coding_agents', undefined, { goal: 'x' }).kind).toBe('allow');
  });
});

describe('clampRunTokens: a caller can lower the declared token budget, never raise it', () => {
  it.each([
    [undefined, 1000], [1e12, 1000], [0, 1000], [-5, 1000], [NaN, 1000], [Infinity, 1000], ['500' as any, 1000],
    [400, 400], [400.9, 400], [1000, 1000],
  ])('requested %j => %j', (requested, expected) => {
    expect(clampRunTokens(requested as any, 1000)).toBe(expected);
  });
});

describe('approvals on runs that do not exist or are already decided', () => {
  let ws = '';
  beforeEach(async () => { ws = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sec-')); });
  afterEach(async () => { await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  const run = (runId: string): any => ({ runId, declarationName: 'x', goal: 'g', workspaceRoot: ws, status: 'paused_approval', budget: { maxTokens: 10, used: 0, reserved: 0, toolCalls: 0 }, createdAt: 1, updatedAt: 1 });

  it('approve / reject / approvals / trace / tasks on an unknown runId fail clearly and create no files', async () => {
    for (const action of ['approve', 'reject'] as const) {
      const r: any = await agentHarness({ action, runId: 'ghost', approvalId: 'a1', workspace_root: ws });
      expect(r.success, action).toBe(false);
      expect(r.error, action).toMatch(/no run/i);
    }
    const list: any = await agentHarness({ action: 'approvals', runId: 'ghost', workspace_root: ws });
    expect(list.error).toMatch(/no run/i);
    const tree = await fs.readdir(ws, { recursive: true } as any).catch(() => []);
    expect((tree as string[]).filter(p => /ghost/.test(String(p)))).toEqual([]);
  });

  it('deciding an approval twice reports what actually happened instead of success', async () => {
    const store = new HarnessStore('r1', ws);
    await store.saveRun(run('r1'));
    const req = await store.createApproval({ runId: 'r1', callId: 'c1', role: 'dev', tool: 't', args: {}, argsHash: 'h', reason: 'r' } as any);
    const first: any = await agentHarness({ action: 'reject', runId: 'r1', approvalId: req.id, workspace_root: ws });
    expect(first.success).toBe(true);
    const second: any = await agentHarness({ action: 'approve', runId: 'r1', approvalId: req.id, workspace_root: ws });
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/already rejected/i);
    expect(second.approval.status).toBe('rejected');
  });

  it('approving an expired approval is refused', async () => {
    const store = new HarnessStore('r2', ws);
    await store.saveRun(run('r2'));
    const req = await store.createApproval({ runId: 'r2', callId: 'c1', role: 'dev', tool: 't', args: {}, argsHash: 'h', reason: 'r' } as any);
    await (store as any).mutateApprovals((list: any[]) => { list.find(a => a.id === req.id).status = 'expired'; });
    const r: any = await agentHarness({ action: 'approve', runId: 'r2', approvalId: req.id, workspace_root: ws });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/expired/i);
  });

  it('a pending approval is decided as before', async () => {
    const store = new HarnessStore('r3', ws);
    await store.saveRun(run('r3'));
    const req = await store.createApproval({ runId: 'r3', callId: 'c1', role: 'dev', tool: 't', args: {}, argsHash: 'h', reason: 'r' } as any);
    const r: any = await agentHarness({ action: 'approve', runId: 'r3', approvalId: req.id, workspace_root: ws });
    expect(r.success).toBe(true);
    expect(r.approval.status).toBe('approved');
  });
});
