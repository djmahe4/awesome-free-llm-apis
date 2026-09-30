import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import type { HarnessDeclaration } from '../src/harness/types.js';
import { waitForSettled } from './helpers/wait-for-run.js';

// P4c — brain: Ebbinghaus-decay recall + write-back + reinforcement
// (docs/plans/2026-09-29-harness-p4-subagents-brain.md, D3). Recall/
// write-back are best-effort: skipped (not failed) when the declaration
// doesn't allowlist manage_memory for top_level, so every pre-existing
// harness declaration (none of which declare a top_level manage_memory
// rule) behaves exactly as before this change — already covered by the
// unmodified P4a/P4b test suites passing unchanged.

const useFreeLLMMock = vi.fn();
const manageMemoryMock = vi.fn();

vi.mock('../src/tools/use-free-llm.js', () => ({ useFreeLLM: (...args: any[]) => useFreeLLMMock(...args) }));
vi.mock('../src/tools/manage-memory.js', () => ({ manageMemory: (...args: any[]) => manageMemoryMock(...args) }));

let currentDecl: HarnessDeclaration;
vi.mock('../src/harness/declaration.js', () => ({
  loadHarnessDeclaration: vi.fn(async () => currentDecl),
  selectRole: vi.fn(() => 'researcher'),
}));

function declWithMemory(): HarnessDeclaration {
  return {
    harness: {
      name: 'brain-test-harness', schemaVersion: 1, primaryLane: 'research',
      budget: { maxTokens: 20000, maxToolCalls: 10, maxWallMinutes: 10, supervisorShareMax: 0.2 },
      approval: { timeoutMinutes: 60, standingRules: [] },
    },
    roles: {
      top_level: { tools: [{ tool: 'manage_memory' }] },
      researcher: { triggers: [], tools: [{ tool: 'use_free_llm', constraints: { agentic: false } }] },
    },
    writes: [{ tool: 'manage_memory', actions: ['wiki_write', 'node_add', 'node_review'] }],
    contentDepth: { order: ['abstract', 'html', 'pdf'], default: 'abstract' },
    handoff: { schemaVersion: 1, lowConfidenceThreshold: 0, maxDepth: 3 }, // 0 => never escalates the P4b ladder; isolates brain behavior
  };
}

describe('harness brain — recall + write-back + reinforcement (integration)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-brain-test-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('injects relevant recalled memory into the first step prompt, and writes back + reinforces a cited node', async () => {
    manageMemoryMock.mockImplementation(async (input: any) => {
      if (input.action === 'graph_query') {
        return {
          nodes: [
            { id: 'node-1', content: 'The CAP theorem was proven by Eric Brewer in 2000.', confidence: 0.9, lastReviewedAt: Date.now(), halfLifeDays: 30 },
            { id: 'node-2', content: 'Completely unrelated content about cooking recipes.', confidence: 0.9, lastReviewedAt: Date.now(), halfLifeDays: 30 },
          ],
        };
      }
      return { success: true };
    });

    useFreeLLMMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'The CAP theorem was proven by Eric Brewer in 2000. This confirms prior memory.' } }],
    });

    currentDecl = declWithMemory();
    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('brain-1', tmpDir);

    await deployHarness({ runId: 'brain-1', goal: 'explain the CAP theorem history', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);

    expect(run?.status).toBe('complete');

    // Recall happened and the relevant (not the unrelated) node was injected.
    const callArgs = useFreeLLMMock.mock.calls[0][0];
    expect(callArgs.messages[1].content).toContain('Eric Brewer');
    expect(callArgs.messages[1].content).not.toContain('cooking recipes');

    // Write-back: node_add and wiki_write both attempted.
    const actions = manageMemoryMock.mock.calls.map(c => c[0].action);
    expect(actions).toContain('node_add');
    expect(actions).toContain('wiki_write');

    // Reinforcement: node-1's content is echoed in the final result (cited) -> reviewed.
    // node-2 was never surfaced (irrelevant, filtered by recall itself) so it can't be reviewed either way.
    const reviewCalls = manageMemoryMock.mock.calls.filter(c => c[0].action === 'node_review');
    expect(reviewCalls).toHaveLength(1);
    expect(reviewCalls[0][0].nodeId).toBe('node-1');
  });

  it('skips recall and write-back entirely (no manageMemory calls) when top_level has no manage_memory rule — pre-existing declarations unaffected', async () => {
    useFreeLLMMock.mockResolvedValueOnce({ choices: [{ message: { content: 'A normal answer.' } }] });
    currentDecl = {
      ...declWithMemory(),
      roles: { researcher: declWithMemory().roles.researcher }, // no top_level role at all
    };

    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('brain-2', tmpDir);

    await deployHarness({ runId: 'brain-2', goal: 'g', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);

    expect(run?.status).toBe('complete');
    expect(manageMemoryMock).not.toHaveBeenCalled();
  });

  it('a memory-layer error during recall never fails the run — best-effort only', async () => {
    manageMemoryMock.mockRejectedValueOnce(new Error('memory backend unavailable'));
    useFreeLLMMock.mockResolvedValueOnce({ choices: [{ message: { content: 'Still completes fine.' } }] });
    currentDecl = declWithMemory();

    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('brain-3', tmpDir);

    await deployHarness({ runId: 'brain-3', goal: 'g', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);

    expect(run?.status).toBe('complete');
    expect(run?.result).toContain('Still completes fine');
  });
});
