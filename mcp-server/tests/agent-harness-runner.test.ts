import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import type { HarnessDeclaration } from '../src/harness/types.js';
import { waitForSettled } from './helpers/wait-for-run.js';

vi.mock('../src/tools/use-free-llm.js', () => ({
  useFreeLLM: vi.fn(async () => ({ choices: [{ message: { content: 'Mocked research finding.' } }] })),
}));

// A minimal declaration whose only role requires a constraint the runner's
// actual payload (agentic:false) does NOT satisfy — forces needs_approval
// deterministically, regardless of goal text, without depending on the
// bundled research-analysis.yaml's real allowlist shape.
const gatedDecl: HarnessDeclaration = {
  harness: {
    name: 'gated-test-harness', schemaVersion: 1, primaryLane: 'research',
    budget: { maxTokens: 10000, maxToolCalls: 5, maxWallMinutes: 10, supervisorShareMax: 0.2 },
    approval: { timeoutMinutes: 60, standingRules: [] },
  },
  roles: {
    researcher: { triggers: [], tools: [{ tool: 'use_free_llm', constraints: { agentic: true } }] },
  },
  writes: [],
  contentDepth: { order: ['abstract', 'html', 'pdf'], default: 'abstract' },
  handoff: { schemaVersion: 1, lowConfidenceThreshold: 0.7, maxDepth: 3 },
};

vi.mock('../src/harness/declaration.js', () => ({
  loadHarnessDeclaration: vi.fn(async () => gatedDecl),
  selectRole: vi.fn(() => 'researcher'),
}));

describe('harness runner — approval binding and resume (integration)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-runner-test-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('parks at paused_approval with the REAL payload recorded, not a placeholder', async () => {
    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');

    const run = await deployHarness({ runId: 'rt-1', goal: 'find the CAP theorem', workspaceRoot: tmpDir });
    expect(run.status).toBe('running'); // deploy returns before the detached work settles

    const store = new HarnessStore('rt-1', tmpDir);
    const finished = await waitForSettled(store);
    expect(finished?.status).toBe('paused_approval');

    const approvals = await store.listApprovals();
    expect(approvals).toHaveLength(1);
    // Before the fix, the hashed/recorded args were the hardcoded placeholder
    // {agentic:false} — not the real messages the call actually executed with.
    expect(JSON.stringify(approvals[0].args)).toContain('find the CAP theorem');
  });

  it('approving does nothing until resume is called, then resume completes the run', async () => {
    const { deployHarness, resumeHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');

    await deployHarness({ runId: 'rt-2', goal: 'find the CAP theorem', workspaceRoot: tmpDir });
    const store = new HarnessStore('rt-2', tmpDir);
    const paused = await waitForSettled(store);
    expect(paused?.status).toBe('paused_approval');

    const [pending] = await store.listApprovals();
    await store.decideApproval(pending.id, true, 'user');

    // Approving alone must not have completed anything — no code re-enters
    // the gated call automatically.
    const stillPaused = await store.loadRun();
    expect(stillPaused?.status).toBe('paused_approval');

    await resumeHarness('rt-2', tmpDir);
    const completed = await waitForSettled(store);
    expect(completed?.status).toBe('complete');
    expect(completed?.result).toContain('Mocked research finding');
  });

  it('a different goal on redeploy does NOT get authorized by an old approval (no replay across runs)', async () => {
    const { deployHarness, resumeHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');

    await deployHarness({ runId: 'rt-3', goal: 'goal A', workspaceRoot: tmpDir });
    const store = new HarnessStore('rt-3', tmpDir);
    await waitForSettled(store);

    const [pending] = await store.listApprovals();
    await store.decideApproval(pending.id, true, 'user');

    // deploy refuses to run over an existing run now — this IS the fix:
    // redeploying used to silently reset the whole run (and its budget)
    // and could execute under an approval that was never actually re-checked
    // against the new payload.
    await expect(deployHarness({ runId: 'rt-3', goal: 'a completely different goal', workspaceRoot: tmpDir }))
      .rejects.toThrow(/already exists/);

    // resume re-hashes the ORIGINAL persisted goal, so the prior approval
    // (for "goal A") still matches and this completes normally.
    await resumeHarness('rt-3', tmpDir);
    const completed = await waitForSettled(store);
    expect(completed?.status).toBe('complete');
    expect(completed?.goal).toBe('goal A');
  });
});
