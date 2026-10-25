import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import type { HarnessDeclaration } from '../src/harness/types.js';
import { waitForSettled } from './helpers/wait-for-run.js';

// H8: the wall-clock budget counted human approval time (from createdAt), and a run paused on budget could
//     never be resumed.
// H9: run.json was written only at deploy and at the very end, with disk errors swallowed.
// H11: two deploys with one runId overwrote each other.

const useFreeLLMMock = vi.fn();
vi.mock('../src/tools/use-free-llm.js', () => ({ useFreeLLM: (...args: any[]) => useFreeLLMMock(...args) }));

let currentDecl: HarnessDeclaration;
vi.mock('../src/harness/declaration.js', () => ({
  loadHarnessDeclaration: vi.fn(async () => currentDecl),
  selectRole: vi.fn(() => 'researcher'),
}));

const decl = (maxWallMinutes: number): HarnessDeclaration => ({
  harness: {
    name: 'persist-test', schemaVersion: 1, primaryLane: 'research',
    budget: { maxTokens: 20000, maxToolCalls: 10, maxWallMinutes, supervisorShareMax: 0.2 },
    approval: { timeoutMinutes: 60, standingRules: [] },
  },
  roles: {
    researcher: { triggers: [], tools: [{ tool: 'use_free_llm', constraints: { agentic: false } }] },
    analyst: { triggers: [], tools: [{ tool: 'use_free_llm', constraints: { agentic: false } }] },
  },
  writes: [],
  contentDepth: { order: ['abstract'], default: 'abstract' },
  handoff: { schemaVersion: 1, lowConfidenceThreshold: 0, maxDepth: 3 },
} as HarnessDeclaration);

const reply = (text: string) => ({ choices: [{ message: { content: text } }] });

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-persist-'));
  vi.clearAllMocks();
  useFreeLLMMock.mockReset();
  currentDecl = decl(10);
});
// Background run work can still be writing when a test ends (Windows CI hit ENOTEMPTY), so retry the cleanup.
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe('H8: wall-clock budget counts active time', () => {
  it('time spent waiting for an approval does not count', async () => {
    const { wallBudgetExceeded } = await import('../src/harness/runner.js');
    const d = decl(5);
    const now = Date.now();
    const base: any = { createdAt: now - 10 * 60_000 };
    expect(wallBudgetExceeded(base, d)).toBe(true);                                           // 10 min of 5
    expect(wallBudgetExceeded({ ...base, pausedMs: 6 * 60_000 }, d)).toBe(false);              // 4 active minutes
    expect(wallBudgetExceeded({ ...base, pausedAt: now - 7 * 60_000 }, d)).toBe(false);        // paused for the last 7 min
    expect(wallBudgetExceeded({ ...base, maxWallMinutes: 60 }, d)).toBe(false);                // run-level raised cap
  });

  it('a run paused on the wall budget can be resumed with a raised cap, and not without one', async () => {
    currentDecl = decl(1 / 60_000 * 5); // 5 ms
    useFreeLLMMock.mockImplementation(async () => { await new Promise(r => setTimeout(r, 40)); return reply('step done'); });
    const { deployHarness, resumeHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('h8-1', tmpDir);
    await deployHarness({ runId: 'h8-1', goal: 'research', workspaceRoot: tmpDir });
    const paused = await waitForSettled(store);
    expect(paused.status).toBe('paused_budget');

    await expect(resumeHarness('h8-1', tmpDir)).rejects.toThrow(/wall-clock budget/i);
    await expect(resumeHarness('h8-1', tmpDir, { maxWallMinutes: 0 })).rejects.toThrow(/maxWallMinutes/i);

    await resumeHarness('h8-1', tmpDir, { maxWallMinutes: 60 });
    const done = await waitForSettled(store);
    expect(done.status).toBe('complete');
    expect(done.maxWallMinutes).toBe(60);
  });
});

describe('H9: run.json is kept current and disk errors are not silent', () => {
  it('after each completed step the persisted run shows the work done so far', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    useFreeLLMMock.mockResolvedValueOnce(reply('first step finished')).mockImplementationOnce(async () => { await gate; return reply('second step finished'); });
    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('h9-1', tmpDir);
    await deployHarness({ runId: 'h9-1', goal: 'research', workspaceRoot: tmpDir });
    await vi.waitFor(() => expect(useFreeLLMMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect((await store.loadRun())!.budget.toolCalls).toBeGreaterThanOrEqual(1));
    release();
    expect((await waitForSettled(store)).status).toBe('complete');
  });

  it('a run.json write failure is traced and does not crash the run', async () => {
    useFreeLLMMock.mockResolvedValue(reply('ok'));
    const { HarnessStore } = await import('../src/harness/store.js');
    vi.spyOn(HarnessStore.prototype, 'saveRun').mockRejectedValue(new Error('ENOSPC: no space left on device'));
    const { deployHarness } = await import('../src/harness/runner.js');
    const store = new HarnessStore('h9-2', tmpDir);
    await deployHarness({ runId: 'h9-2', goal: 'research', workspaceRoot: tmpDir });
    await vi.waitFor(async () => {
      const trace = await store.readTrace(200);
      expect(trace.some((e: any) => e.type === 'run_end')).toBe(true);
      expect(trace.some((e: any) => e.type === 'error' && /run\.json could not be written.*ENOSPC/.test(String(e.data?.message)))).toBe(true);
    }, { timeout: 15000 });
    await new Promise(res => setTimeout(res, 200)); // the run's last background writes
  });
});

describe('H11: one run id, one run', () => {
  it('a second deploy of the same runId is refused and leaves the first run alone', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    useFreeLLMMock.mockImplementation(async () => { await gate; return reply('done'); });
    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('h11-1', tmpDir);
    await deployHarness({ runId: 'h11-1', goal: 'first goal', workspaceRoot: tmpDir });
    await expect(deployHarness({ runId: 'h11-1', goal: 'second goal', workspaceRoot: tmpDir })).rejects.toThrow(/already exists/i);
    expect((await store.loadRun())!.goal).toBe('first goal');
    release();
    expect((await waitForSettled(store)).status).toBe('complete');
  });

  it('concurrent deploys of one runId: exactly one wins', async () => {
    useFreeLLMMock.mockResolvedValue(reply('done'));
    const { deployHarness } = await import('../src/harness/runner.js');
    const results = await Promise.allSettled([
      deployHarness({ runId: 'h11-2', goal: 'a', workspaceRoot: tmpDir }),
      deployHarness({ runId: 'h11-2', goal: 'b', workspaceRoot: tmpDir }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    // let the winning run finish before the test ends and its directory is removed
    const { HarnessStore } = await import('../src/harness/store.js');
    expect((await waitForSettled(new HarnessStore('h11-2', tmpDir))).status).toBe('complete');
  });
});
