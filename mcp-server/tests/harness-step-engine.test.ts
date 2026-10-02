import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import type { HarnessDeclaration } from '../src/harness/types.js';
import { waitForSettled } from './helpers/wait-for-run.js';

// P4a — step engine + handoff contract + per-role tool router
// (docs/plans/2026-09-29-harness-p4-subagents-brain.md). Verifies: a
// declaration with both 'researcher' and 'analyst' roles runs as a real
// two-step chain (not just one call), each step produces a validated
// handoff, resume continues from the first non-completed step (not from
// scratch), and the repeat-detector primitive trips on a genuine duplicate.

const useFreeLLMMock = vi.fn();
vi.mock('../src/tools/use-free-llm.js', () => ({ useFreeLLM: (...args: any[]) => useFreeLLMMock(...args) }));

let currentDecl: HarnessDeclaration;
vi.mock('../src/harness/declaration.js', () => ({
  loadHarnessDeclaration: vi.fn(async () => currentDecl),
  selectRole: vi.fn(() => 'researcher'),
}));

function twoStepDecl(researcherConstraints: Record<string, unknown> = { agentic: false }): HarnessDeclaration {
  return {
    harness: {
      name: 'two-step-test-harness', schemaVersion: 1, primaryLane: 'research',
      budget: { maxTokens: 20000, maxToolCalls: 10, maxWallMinutes: 10, supervisorShareMax: 0.2 },
      approval: { timeoutMinutes: 60, standingRules: [] },
    },
    roles: {
      researcher: { triggers: [], tools: [{ tool: 'use_free_llm', constraints: researcherConstraints }] },
      analyst: { triggers: [], tools: [{ tool: 'use_free_llm', constraints: { agentic: false } }] },
    },
    writes: [],
    contentDepth: { order: ['abstract', 'html', 'pdf'], default: 'abstract' },
    handoff: { schemaVersion: 1, lowConfidenceThreshold: 0.7, maxDepth: 3 },
  };
}

describe('harness step engine — two-role chain (integration)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-step-engine-test-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('runs researcher then analyst as two real steps, chaining a validated handoff between them', async () => {
    useFreeLLMMock
      .mockResolvedValueOnce({ choices: [{ message: { content: 'CAP theorem: consistency, availability, partition tolerance.' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Synthesis: the tradeoffs are well-established in distributed systems literature.' } }] });

    currentDecl = twoStepDecl();
    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');

    const store = new HarnessStore('chain-1', tmpDir);
    await deployHarness({ runId: 'chain-1', goal: 'explain the CAP theorem', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);

    expect(useFreeLLMMock).toHaveBeenCalledTimes(2);
    expect(run?.status).toBe('complete');
    expect(run?.result).toContain('Synthesis');

    const events = await store.readTrace();
    const handoffs = events.filter(e => e.type === 'handoff').map(e => e.data as any);
    expect(handoffs).toHaveLength(2);
    expect(handoffs[0].from).toBe('researcher');
    expect(handoffs[0].to).toBe('analyst');
    expect(handoffs[0].confidence).toBeGreaterThan(0);
    expect(handoffs[1].from).toBe('analyst');
    expect(handoffs[1].to).toBe('top_level');

    // The second call's prompt must actually be built from the first step's
    // findings, not the raw original goal repeated verbatim.
    const secondCallArgs = useFreeLLMMock.mock.calls[1][0];
    expect(secondCallArgs.messages[1].content).toContain('consistency, availability, partition tolerance');
  });

  it('resumes from the second step (not from scratch) when the first step already completed', async () => {
    // researcher's real payload (agentic:false) satisfies its own allowlist,
    // but analyst here requires agentic:true, which the runner never sends —
    // forces a pause exactly at step 2.
    useFreeLLMMock.mockResolvedValueOnce({ choices: [{ message: { content: 'First step finding.' } }] });
    currentDecl = twoStepDecl();
    currentDecl.roles.analyst.tools[0].constraints = { agentic: true };

    const { deployHarness, resumeHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const { agentHarness } = await import('../src/tools/agent-harness.js');

    const store = new HarnessStore('chain-2', tmpDir);
    await deployHarness({ runId: 'chain-2', goal: 'explain the CAP theorem', workspaceRoot: tmpDir });
    let run = await waitForSettled(store);

    expect(useFreeLLMMock).toHaveBeenCalledTimes(1); // only step 1 ran
    expect(run?.status).toBe('paused_approval');

    const tasksBefore = ((await agentHarness({ action: 'tasks', runId: 'chain-2', workspace_root: tmpDir })) as any).tasks;
    expect(tasksBefore.find((t: any) => t.id === 'researcher').status).toBe('completed');
    expect(tasksBefore.find((t: any) => t.id === 'analyst').status).toBe('pending');

    const [pending] = await store.listApprovals();
    await store.decideApproval(pending.id, true, 'user');

    useFreeLLMMock.mockResolvedValueOnce({ choices: [{ message: { content: 'Second step synthesis.' } }] });
    await resumeHarness('chain-2', tmpDir);
    run = await waitForSettled(store);

    // Resume must NOT have re-run step 1 — only the one additional call for step 2.
    expect(useFreeLLMMock).toHaveBeenCalledTimes(2);
    expect(run?.status).toBe('complete');
    expect(run?.result).toContain('Second step synthesis');

    const tasksAfter = ((await agentHarness({ action: 'tasks', runId: 'chain-2', workspace_root: tmpDir })) as any).tasks;
    expect(tasksAfter.find((t: any) => t.id === 'analyst').status).toBe('completed');
  });

  it('single-role declarations (no analyst) still run exactly one step, unchanged', async () => {
    useFreeLLMMock.mockResolvedValueOnce({ choices: [{ message: { content: 'Only step.' } }] });
    currentDecl = {
      ...twoStepDecl(),
      roles: { researcher: { triggers: [], tools: [{ tool: 'use_free_llm', constraints: { agentic: false } }] } },
    };

    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');

    const store = new HarnessStore('chain-3', tmpDir);
    await deployHarness({ runId: 'chain-3', goal: 'g', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);

    expect(useFreeLLMMock).toHaveBeenCalledTimes(1);
    expect(run?.status).toBe('complete');

    const events = await store.readTrace();
    expect(events.filter(e => e.type === 'handoff')).toHaveLength(1);
  });
});

describe('harness step engine — repeat detector (unit)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-repeat-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('trips when the same callId+argsHash already reached a successful tool_result', async () => {
    const { hasRepeatedSuccess } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');

    const store = new HarnessStore('repeat-1', tmpDir);
    await store.appendTrace({
      runId: 'repeat-1', role: 'researcher', type: 'tool_result',
      data: { tool: 'use_free_llm', callId: 's0:researcher', ok: true, argsHash: 'abc123' },
    });

    expect(await hasRepeatedSuccess(store, 's0:researcher', 'abc123')).toBe(true);
    expect(await hasRepeatedSuccess(store, 's0:researcher', 'different-hash')).toBe(false);
    expect(await hasRepeatedSuccess(store, 's1:analyst', 'abc123')).toBe(false);
  });

  it('does not trip on a pending (not-yet-succeeded) call — an ordinary approval-pause replay is not a repeat', async () => {
    const { hasRepeatedSuccess } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');

    const store = new HarnessStore('repeat-2', tmpDir);
    await store.appendTrace({
      runId: 'repeat-2', role: 'researcher', type: 'tool_call',
      data: { tool: 'use_free_llm', callId: 's0:researcher', argsHash: 'abc123' },
    });
    // Only a tool_call (needs_approval path) exists — no successful tool_result yet.
    expect(await hasRepeatedSuccess(store, 's0:researcher', 'abc123')).toBe(false);
  });
});
