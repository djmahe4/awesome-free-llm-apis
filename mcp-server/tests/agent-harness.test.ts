import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { evaluate, hashArgs } from '../src/harness/policy.js';
import { HarnessStore } from '../src/harness/store.js';
import { loadHarnessDeclaration, selectRole } from '../src/harness/declaration.js';
import type { HarnessDeclaration } from '../src/harness/types.js';

describe('harness policy', () => {
  const decl: HarnessDeclaration = {
    harness: {
      name: 'test-harness', schemaVersion: 1, primaryLane: 'research',
      budget: { maxTokens: 1000, maxToolCalls: 5, maxWallMinutes: 10, supervisorShareMax: 0.2 },
      approval: { timeoutMinutes: 60, standingRules: [] },
    },
    roles: {
      researcher: { triggers: ['research'], tools: [{ tool: 'use_free_llm', constraints: { agentic: false } }] },
      coder: { requiresApproval: true, tools: [{ tool: 'coding_agents' }] },
    },
    writes: [{ tool: 'manage_memory', actions: ['wiki_write'] }],
    contentDepth: { order: ['abstract', 'html', 'pdf'], default: 'abstract' },
    handoff: { schemaVersion: 1, lowConfidenceThreshold: 0.7, maxDepth: 3 },
  };

  it('allows a call matching an allowlist rule with matching constraints', () => {
    const decision = evaluate(decl, 'researcher', 'use_free_llm', undefined, { agentic: false });
    expect(decision.kind).toBe('allow');
  });

  it('requires approval when constraints do not match', () => {
    const decision = evaluate(decl, 'researcher', 'use_free_llm', undefined, { agentic: true });
    expect(decision.kind).toBe('needs_approval');
  });

  it('requires approval for a tool with no matching rule', () => {
    const decision = evaluate(decl, 'researcher', 'browser_tool', 'navigate', {});
    expect(decision.kind).toBe('needs_approval');
  });

  it('always requires approval for a requiresApproval role, even with a matching rule', () => {
    const decision = evaluate(decl, 'coder', 'coding_agents', undefined, {});
    expect(decision.kind).toBe('needs_approval');
  });

  it('denies an unknown role', () => {
    const decision = evaluate(decl, 'ghost', 'use_free_llm', undefined, {});
    expect(decision.kind).toBe('deny');
  });

  it('allows shared writes rules regardless of role', () => {
    const decision = evaluate(decl, 'researcher', 'manage_memory', 'wiki_write', {});
    expect(decision.kind).toBe('allow');
  });

  it('hashArgs is stable regardless of key order', () => {
    expect(hashArgs({ a: 1, b: 2 })).toBe(hashArgs({ b: 2, a: 1 }));
  });

  it('hashArgs differs for different argument values', () => {
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
  });
});

describe('harness declaration selection', () => {
  it('loads the bundled research-analysis declaration', async () => {
    const decl = await loadHarnessDeclaration('research-analysis');
    expect(decl.harness.name).toBe('research-analysis-harness');
    expect(decl.roles.researcher).toBeDefined();
    expect(decl.roles.coder.requiresApproval).toBe(true);
  });

  it('selects a role by trigger match', async () => {
    const decl = await loadHarnessDeclaration('research-analysis');
    expect(selectRole(decl, 'please scrape this table')).toBe('scraper');
    expect(selectRole(decl, 'research this paper on arxiv')).toBe('researcher');
  });

  it('falls back to researcher when nothing matches', async () => {
    const decl = await loadHarnessDeclaration('research-analysis');
    expect(selectRole(decl, 'a goal with no trigger words at all')).toBe('researcher');
  });
});

describe('HarnessStore', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-store-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('round-trips a run record', async () => {
    const store = new HarnessStore('run-1', tmpDir);
    await store.saveRun({
      runId: 'run-1', harness: 'test', goal: 'g', status: 'running',
      budget: { maxTokens: 100, used: 0, reserved: 0, toolCalls: 0 },
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    const loaded = await store.loadRun();
    expect(loaded?.runId).toBe('run-1');
  });

  it('returns null for a run that was never saved', async () => {
    const store = new HarnessStore('missing-run', tmpDir);
    expect(await store.loadRun()).toBeNull();
  });

  it('binds an approval to the exact call it was created for', async () => {
    const store = new HarnessStore('run-2', tmpDir);
    const req = await store.createApproval({
      runId: 'run-2', callId: 'call-1', role: 'coder', tool: 'coding_agents',
      args: { goal: 'x' }, argsHash: hashArgs({ goal: 'x' }), reason: 'gated',
    });
    expect(await store.findApprovedFor('run-2', 'call-1', req.argsHash)).toBeNull(); // still pending

    await store.decideApproval(req.id, true, 'user');
    expect(await store.findApprovedFor('run-2', 'call-1', req.argsHash)).not.toBeNull();

    // Different args for the same call id must NOT be authorized by that approval.
    expect(await store.findApprovedFor('run-2', 'call-1', hashArgs({ goal: 'different' }))).toBeNull();
  });

  it('expires a pending approval past its timeout', async () => {
    const store = new HarnessStore('run-3', tmpDir);
    const req = await store.createApproval({
      runId: 'run-3', callId: 'call-1', role: 'coder', tool: 'coding_agents',
      args: {}, argsHash: hashArgs({}), reason: 'gated',
    });
    // Force it into the past by re-saving with an old createdAt.
    const list = await store.listApprovals();
    list[0].createdAt = Date.now() - 120 * 60_000;
    await fs.writeFile(path.join(tmpDir, '.free-llm-mcp', 'harness', 'run-3', 'approvals.json'), JSON.stringify(list, null, 2), 'utf-8');

    await store.expireStale(60);
    const after = await store.listApprovals();
    expect(after.find(a => a.id === req.id)?.status).toBe('expired');
  });

  it('appends and reads back trace events with monotonically increasing seq', async () => {
    const store = new HarnessStore('run-4', tmpDir);
    await store.appendTrace({ runId: 'run-4', role: 'top_level', type: 'run_start', data: { goal: 'g' } });
    await store.appendTrace({ runId: 'run-4', role: 'researcher', type: 'tool_call', data: { tool: 'use_free_llm' } });
    const events = await store.readTrace();
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(0);
    expect(events[1].seq).toBe(1);
    expect(events[1].type).toBe('tool_call');
  });

  it('truncates oversized trace data', async () => {
    const store = new HarnessStore('run-5', tmpDir);
    const huge = 'x'.repeat(5000);
    await store.appendTrace({ runId: 'run-5', role: 'top_level', type: 'tool_result', data: huge });
    const events = await store.readTrace();
    expect((events[0].data as string).length).toBeLessThan(5000);
    expect(events[0].data).toContain('truncated');
  });
});
