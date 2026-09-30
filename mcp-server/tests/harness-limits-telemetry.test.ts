import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import type { HarnessDeclaration } from '../src/harness/types.js';
import { waitForSettled } from './helpers/wait-for-run.js';

// P4f — limits + telemetry (docs/plans/2026-09-29-harness-p4-subagents-
// brain.md): maxWallMinutes enforcement (declared in config since P0, never
// read anywhere), per-role token accounting (budget.used was a single flat
// counter despite `role` being in scope at the increment site), and a
// supervisorShareMax trace warning. The `tasks` action already returned the
// full step list before this change (confirmed via investigation) — no
// work needed there.

const useFreeLLMMock = vi.fn(async () => ({ choices: [{ message: { content: 'An answer.' } }] }));
const manageMemoryMock = vi.fn(async () => ({ success: true }));
vi.mock('../src/tools/use-free-llm.js', () => ({ useFreeLLM: (...args: any[]) => useFreeLLMMock(...args) }));
vi.mock('../src/tools/manage-memory.js', () => ({ manageMemory: (...args: any[]) => manageMemoryMock(...args) }));

let currentDecl: HarnessDeclaration;
vi.mock('../src/harness/declaration.js', () => ({
  loadHarnessDeclaration: vi.fn(async () => currentDecl),
  selectRole: vi.fn(() => 'researcher'),
}));

function decl(overrides: Partial<HarnessDeclaration['harness']['budget']> = {}): HarnessDeclaration {
  return {
    harness: {
      name: 'limits-test-harness', schemaVersion: 1, primaryLane: 'research',
      budget: { maxTokens: 20000, maxToolCalls: 10, maxWallMinutes: 10, supervisorShareMax: 0.2, ...overrides },
      approval: { timeoutMinutes: 60, standingRules: [] },
    },
    roles: { researcher: { triggers: [], tools: [{ tool: 'use_free_llm', constraints: { agentic: false } }] } },
    writes: [],
    contentDepth: { order: ['abstract', 'html', 'pdf'], default: 'abstract' },
    handoff: { schemaVersion: 1, lowConfidenceThreshold: 0, maxDepth: 3 },
  };
}

describe('harness limits + telemetry (integration)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-limits-test-'));
    vi.clearAllMocks();
    useFreeLLMMock.mockResolvedValue({ choices: [{ message: { content: 'An answer.' } }] });
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('records used tokens under the executing role', async () => {
    currentDecl = decl();
    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('limits-1', tmpDir);

    await deployHarness({ runId: 'limits-1', goal: 'g', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);

    expect(run?.status).toBe('complete');
    expect(run?.budget.perRole?.researcher).toBeGreaterThan(0);
    expect(run?.budget.perRole?.researcher).toBe(run?.budget.used);
  });

  it('pauses with paused_budget when a resumed run has already exceeded maxWallMinutes', async () => {
    // needs_approval constraint forces a pause deterministically so we can
    // rewrite the persisted run's createdAt into the past before resuming,
    // without depending on real elapsed wall-clock time in a fast unit test.
    currentDecl = {
      ...decl({ maxWallMinutes: 1 }),
      roles: { researcher: { triggers: [], tools: [{ tool: 'use_free_llm', constraints: { agentic: true } }] } },
    };

    const { deployHarness, resumeHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('limits-2', tmpDir);

    await deployHarness({ runId: 'limits-2', goal: 'g', workspaceRoot: tmpDir });
    const paused = await waitForSettled(store);
    expect(paused?.status).toBe('paused_approval');

    const [pending] = await store.listApprovals();
    await store.decideApproval(pending.id, true, 'user');

    const persisted = await store.loadRun();
    persisted!.createdAt = Date.now() - 5 * 60 * 1000; // 5 minutes ago, past the 1-minute limit
    await store.saveRun(persisted!);

    await resumeHarness('limits-2', tmpDir);
    const run = await waitForSettled(store);

    expect(run?.status).toBe('paused_budget');
    expect(run?.error).toContain('Wall-clock budget exceeded');

    const events = await store.readTrace();
    expect(events.some(e => e.type === 'budget' && (e.data as any).reason === 'maxWallMinutes exceeded')).toBe(true);
  });

  it('does not pause on wall-clock when maxWallMinutes is generous', async () => {
    currentDecl = decl({ maxWallMinutes: 999 });
    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('limits-3', tmpDir);

    await deployHarness({ runId: 'limits-3', goal: 'g', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);
    expect(run?.status).toBe('complete');
  });

  it('warns via a budget trace event when supervisorShareMax is exceeded by top_level enrichment calls', async () => {
    manageMemoryMock.mockImplementation(async (input: any) => {
      if (input.action === 'graph_query') return { nodes: [] };
      return { success: true };
    });

    currentDecl = {
      ...decl({ supervisorShareMax: 0.0001 }), // near-zero threshold -> any top_level activity trips it
      roles: {
        top_level: { tools: [{ tool: 'manage_memory' }] },
        researcher: { triggers: [], tools: [{ tool: 'use_free_llm', constraints: { agentic: false } }] },
      },
      writes: [{ tool: 'manage_memory', actions: ['node_add', 'wiki_write'] }],
    };

    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('limits-4', tmpDir);

    await deployHarness({ runId: 'limits-4', goal: 'g', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);
    expect(run?.status).toBe('complete');

    const events = await store.readTrace();
    expect(events.some(e => e.type === 'budget' && (e.data as any).reason === 'supervisor share exceeded')).toBe(true);
  });
});
