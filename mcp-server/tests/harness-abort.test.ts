import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import type { HarnessDeclaration } from '../src/harness/types.js';
import { waitForSettled } from './helpers/wait-for-run.js';

// abort used to be a no-op for a running run: the runner read
// controller.signal.aborted ONCE at launch (always false) and passed that boolean down,
// so abort flipped the controller but no step ever saw it.

const useFreeLLMMock = vi.fn();
vi.mock('../src/tools/use-free-llm.js', () => ({ useFreeLLM: (...args: any[]) => useFreeLLMMock(...args) }));

let currentDecl: HarnessDeclaration;
vi.mock('../src/harness/declaration.js', () => ({
  loadHarnessDeclaration: vi.fn(async () => currentDecl),
  selectRole: vi.fn(() => 'researcher'),
}));

function twoRoleDecl(): HarnessDeclaration {
  return {
    harness: {
      name: 'abort-test', schemaVersion: 1, primaryLane: 'research',
      budget: { maxTokens: 20000, maxToolCalls: 10, maxWallMinutes: 10, supervisorShareMax: 0.2 },
      approval: { timeoutMinutes: 60, standingRules: [] },
    },
    roles: {
      researcher: { triggers: [], tools: [{ tool: 'use_free_llm', constraints: { agentic: false } }] },
      analyst: { triggers: [], tools: [{ tool: 'use_free_llm', constraints: { agentic: false } }] },
    },
    writes: [],
    contentDepth: { order: ['abstract'], default: 'abstract' },
    handoff: { schemaVersion: 1, lowConfidenceThreshold: 0, maxDepth: 3 },
  } as HarnessDeclaration;
}

const reply = (text: string) => ({ choices: [{ message: { content: text } }] });

describe('agent_harness abort', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-abort-test-'));
    vi.clearAllMocks();
    currentDecl = twoRoleDecl();
  });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it('stops a running run: the next step never starts and the persisted status is aborted', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    useFreeLLMMock.mockImplementationOnce(async () => { await gate; return reply('first step finished'); });
    useFreeLLMMock.mockResolvedValue(reply('second step should never run'));

    const { deployHarness, abortHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('abort-1', tmpDir);
    await deployHarness({ runId: 'abort-1', goal: 'research something', workspaceRoot: tmpDir });

    // first step is now blocked inside the model call
    await vi.waitFor(() => expect(useFreeLLMMock).toHaveBeenCalledTimes(1), { timeout: 15000 });
    expect(abortHarness('abort-1')).toBe(true);
    release();

    const run = await waitForSettled(store);
    expect(run.status).toBe('aborted');
    expect(useFreeLLMMock).toHaveBeenCalledTimes(1);
  });

  it('abort of an unknown or finished run reports false', async () => {
    const { abortHarness } = await import('../src/harness/runner.js');
    expect(abortHarness('no-such-run')).toBe(false);
  });
});

describe('agentHarness abort when the live run is gone from the registry', () => {
  let tmpDir: string;
  beforeEach(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-abort2-')); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it('marks a persisted non-terminal run aborted (restart / registry TTL) instead of an unexplained false', async () => {
    const { HarnessStore } = await import('../src/harness/store.js');
    const { agentHarness } = await import('../src/tools/agent-harness.js');
    const store = new HarnessStore('orphan-1', tmpDir);
    await store.saveRun({ runId: 'orphan-1', harness: 'x', goal: 'g', workspaceRoot: tmpDir, status: 'running', budget: { maxTokens: 10, used: 0, reserved: 0, toolCalls: 0 }, createdAt: 1, updatedAt: 1 } as any);

    const r: any = await agentHarness({ action: 'abort', runId: 'orphan-1', workspace_root: tmpDir });
    expect(r.success).toBe(true);
    expect((await store.loadRun())?.status).toBe('aborted');
  });

  it('says why when there is nothing to abort', async () => {
    const { HarnessStore } = await import('../src/harness/store.js');
    const { agentHarness } = await import('../src/tools/agent-harness.js');
    const store = new HarnessStore('done-1', tmpDir);
    await store.saveRun({ runId: 'done-1', harness: 'x', goal: 'g', workspaceRoot: tmpDir, status: 'complete', budget: { maxTokens: 10, used: 0, reserved: 0, toolCalls: 0 }, createdAt: 1, updatedAt: 1 } as any);

    const finished: any = await agentHarness({ action: 'abort', runId: 'done-1', workspace_root: tmpDir });
    expect(finished.success).toBe(false);
    expect(finished.error).toMatch(/already complete/i);

    const missing: any = await agentHarness({ action: 'abort', runId: 'ghost', workspace_root: tmpDir });
    expect(missing.success).toBe(false);
    expect(missing.error).toMatch(/no run/i);
  });
});
