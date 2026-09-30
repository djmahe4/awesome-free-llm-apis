import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import type { HarnessDeclaration } from '../src/harness/types.js';
import { waitForSettled } from './helpers/wait-for-run.js';

// P4e — trial-and-error (docs/plans/2026-09-29-harness-p4-subagents-brain.md,
// D5). Wires the already-built (but previously unwired) reasoning.ts into
// the step engine: bounded retries on a genuine failure, a lesson node
// written per failed attempt, reinforcement on a successful retry that
// reused a past lesson. Quantum adjudication itself is reasoning.ts's own
// concern (tests/reasoning.test.ts) — not re-tested here.

const useFreeLLMMock = vi.fn();
const manageMemoryMock = vi.fn();

vi.mock('../src/tools/use-free-llm.js', () => ({ useFreeLLM: (...args: any[]) => useFreeLLMMock(...args) }));
vi.mock('../src/tools/manage-memory.js', () => ({ manageMemory: (...args: any[]) => manageMemoryMock(...args) }));

let currentDecl: HarnessDeclaration;
vi.mock('../src/harness/declaration.js', () => ({
  loadHarnessDeclaration: vi.fn(async () => currentDecl),
  selectRole: vi.fn(() => 'researcher'),
}));

function declWithMemory(maxAttemptsPerStep?: number): HarnessDeclaration {
  return {
    harness: {
      name: 'trial-error-test-harness', schemaVersion: 1, primaryLane: 'research',
      budget: { maxTokens: 20000, maxToolCalls: 20, maxWallMinutes: 10, supervisorShareMax: 0.2 },
      approval: { timeoutMinutes: 60, standingRules: [] },
    },
    roles: {
      top_level: { tools: [{ tool: 'manage_memory' }] },
      researcher: { triggers: [], tools: [{ tool: 'use_free_llm', constraints: { agentic: false } }] },
    },
    writes: [{ tool: 'manage_memory', actions: ['node_add', 'node_review'] }],
    contentDepth: { order: ['abstract', 'html', 'pdf'], default: 'abstract' },
    handoff: { schemaVersion: 1, lowConfidenceThreshold: 0, maxDepth: 3 },
    limits: maxAttemptsPerStep !== undefined ? { maxAttemptsPerStep } : undefined,
  };
}

describe('harness trial-and-error — bounded retry on failure (integration)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-trial-error-test-'));
    vi.clearAllMocks();
    manageMemoryMock.mockImplementation(async (input: any) => {
      if (input.action === 'graph_query') return { nodes: [] };
      return { success: true };
    });
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('retries an empty-content failure once (default maxAttemptsPerStep 2), succeeds on the second attempt, writes a lesson node', async () => {
    useFreeLLMMock
      .mockResolvedValueOnce({ choices: [{ message: { content: '' } }] }) // attempt 1: empty -> failed
      .mockResolvedValueOnce({ choices: [{ message: { content: 'A real answer on retry.' } }] }); // attempt 2: succeeds

    currentDecl = declWithMemory();
    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('trial-1', tmpDir);

    await deployHarness({ runId: 'trial-1', goal: 'explain something', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);

    expect(useFreeLLMMock).toHaveBeenCalledTimes(2);
    expect(run?.status).toBe('complete');
    expect(run?.result).toContain('A real answer on retry');

    const lessonWrites = manageMemoryMock.mock.calls.filter(
      c => c[0].action === 'node_add' && Array.isArray(c[0].node?.tags) && c[0].node.tags.includes('lesson')
    );
    expect(lessonWrites).toHaveLength(1);
    expect(lessonWrites[0][0].node.tags).toEqual(expect.arrayContaining(['lesson', 'researcher', 'use_free_llm']));

    const retryCallEvent = (await store.readTrace()).find(e => e.type === 'tool_call' && (e.data as any).callId?.endsWith(':a2'));
    expect(retryCallEvent).toBeDefined();
  });

  it('gives up after maxAttemptsPerStep attempts when every retry still fails', async () => {
    useFreeLLMMock.mockResolvedValue({ choices: [{ message: { content: '' } }] }); // always empty

    currentDecl = declWithMemory(3);
    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('trial-2', tmpDir);

    await deployHarness({ runId: 'trial-2', goal: 'g', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);

    expect(useFreeLLMMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries, bounded by maxAttemptsPerStep:3
    expect(run?.status).toBe('failed');
  });

  it('does not retry at all when the step needs approval — retries are only for genuine failures, never for a legitimate pause', async () => {
    currentDecl = {
      ...declWithMemory(),
      roles: {
        ...declWithMemory().roles,
        researcher: { triggers: [], tools: [{ tool: 'use_free_llm', constraints: { agentic: true } }] }, // real payload (agentic:false) never matches
      },
    };

    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('trial-3', tmpDir);

    await deployHarness({ runId: 'trial-3', goal: 'g', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);

    expect(useFreeLLMMock).not.toHaveBeenCalled(); // never even reached the LLM — parked on approval before that
    expect(run?.status).toBe('paused_approval');
  });

  it('a memory-layer error during lesson recall/write never blocks the retry itself — best-effort only', async () => {
    manageMemoryMock.mockRejectedValue(new Error('memory backend down'));
    useFreeLLMMock
      .mockResolvedValueOnce({ choices: [{ message: { content: '' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Succeeded despite memory errors.' } }] });

    currentDecl = declWithMemory();
    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('trial-4', tmpDir);

    await deployHarness({ runId: 'trial-4', goal: 'g', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);

    expect(run?.status).toBe('complete');
    expect(run?.result).toContain('Succeeded despite memory errors');
  });
});
