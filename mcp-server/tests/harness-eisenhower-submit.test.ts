import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import type { HarnessDeclaration } from '../src/harness/types.js';
import { waitForSettled } from './helpers/wait-for-run.js';

// P4d — Eisenhower review, SUBMIT half only (docs/plans/2026-09-29-harness-
// p4-subagents-brain.md, D4). Open questions the final step actually
// phrased (handoff.ts's extractOpenQuestions) become eisenhower_add tasks
// with deterministic urgent/important flags. Reading the backlog back and
// acting per quadrant (esp. `delegate` -> sub-run) is explicitly NOT
// implemented here.

const useFreeLLMMock = vi.fn();
const manageMemoryMock = vi.fn();

vi.mock('../src/tools/use-free-llm.js', () => ({ useFreeLLM: (...args: any[]) => useFreeLLMMock(...args) }));
vi.mock('../src/tools/manage-memory.js', () => ({ manageMemory: (...args: any[]) => manageMemoryMock(...args) }));

let currentDecl: HarnessDeclaration;
vi.mock('../src/harness/declaration.js', () => ({
  loadHarnessDeclaration: vi.fn(async () => currentDecl),
  selectRole: vi.fn(() => 'researcher'),
}));

function decl(): HarnessDeclaration {
  return {
    harness: {
      name: 'eisenhower-test-harness', schemaVersion: 1, primaryLane: 'research',
      budget: { maxTokens: 20000, maxToolCalls: 10, maxWallMinutes: 10, supervisorShareMax: 0.2 },
      approval: { timeoutMinutes: 60, standingRules: [] },
    },
    roles: {
      top_level: { tools: [{ tool: 'manage_memory' }] },
      researcher: { triggers: [], tools: [{ tool: 'use_free_llm', constraints: { agentic: false } }] },
    },
    writes: [{ tool: 'manage_memory', actions: ['eisenhower_add'] }],
    contentDepth: { order: ['abstract', 'html', 'pdf'], default: 'abstract' },
    handoff: { schemaVersion: 1, lowConfidenceThreshold: 0, maxDepth: 3 },
  };
}

describe('harness eisenhower review — submit half (integration)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-eisenhower-test-'));
    vi.clearAllMocks();
    manageMemoryMock.mockResolvedValue({ success: true });
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('submits a real open question from the reply as an eisenhower_add task, important because it shares a finding term', async () => {
    useFreeLLMMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'The CAP theorem trades consistency for availability.\nDoes this hold under partial network partitions?' } }],
    });
    currentDecl = decl();

    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('eis-1', tmpDir);

    await deployHarness({ runId: 'eis-1', goal: 'explain the CAP theorem', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);
    expect(run?.status).toBe('complete');

    const eisenhowerCalls = manageMemoryMock.mock.calls.filter(c => c[0].action === 'eisenhower_add');
    expect(eisenhowerCalls).toHaveLength(1);
    expect(eisenhowerCalls[0][0].task).toContain('partial network partitions');
    expect(eisenhowerCalls[0][0].important).toBe(true); // shares "partitions"/"consistency" etc. with the finding
    expect(eisenhowerCalls[0][0].urgent).toBe(false); // run completed cleanly, nothing blocking
  });

  it('does not submit anything when the reply contains no question', async () => {
    useFreeLLMMock.mockResolvedValueOnce({ choices: [{ message: { content: 'A plain statement with no questions at all.' } }] });
    currentDecl = decl();

    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('eis-2', tmpDir);

    await deployHarness({ runId: 'eis-2', goal: 'g', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);
    expect(run?.status).toBe('complete');

    expect(manageMemoryMock.mock.calls.some(c => c[0].action === 'eisenhower_add')).toBe(false);
  });

  it('skips submission entirely when top_level has no manage_memory rule — pre-existing declarations unaffected', async () => {
    useFreeLLMMock.mockResolvedValueOnce({ choices: [{ message: { content: 'An answer. What about edge cases?' } }] });
    currentDecl = { ...decl(), roles: { researcher: decl().roles.researcher } };

    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('eis-3', tmpDir);

    await deployHarness({ runId: 'eis-3', goal: 'g', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);
    expect(run?.status).toBe('complete');
    expect(manageMemoryMock).not.toHaveBeenCalled();
  });
});
