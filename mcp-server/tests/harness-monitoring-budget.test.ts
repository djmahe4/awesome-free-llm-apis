import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import type { HarnessDeclaration } from '../src/harness/types.js';
import { waitForSettled } from './helpers/wait-for-run.js';
import { MonitorRegistry } from '../src/harness/monitor.js';

// P5c — budget + approval integration under a detached (monitoring) run.
//
// Scope note, stated plainly rather than glossed over: cyber_tool's osint
// scan (the one concrete detached user wired so far, P5b) has no natural
// per-progress-event TOKEN cost to settle mid-flight (a web search call
// isn't token-metered the way an LLM call is), and no natural decision
// point where it would create its own mid-flight ApprovalRequest either —
// so neither "token budget settles incrementally" (D3) nor "the monitored
// process itself creates an approval" (D4) has anything real to test
// against THIS detached user. What IS real and tested here: attach-time
// budget/policy gating (gatedDetach uses the exact same gate as gatedCall,
// no exception for detached work) and mid-flight WALL-CLOCK budget, the one
// budget dimension that applies uniformly regardless of what the detached
// process actually does.

const cyberToolMock = vi.fn(async () => ({ success: true }));
vi.mock('../src/tools/cyber-tool.js', () => ({ cyberTool: (...args: any[]) => cyberToolMock(...args) }));

let currentDecl: HarnessDeclaration;
vi.mock('../src/harness/declaration.js', () => ({
  loadHarnessDeclaration: vi.fn(async () => currentDecl),
  selectRole: vi.fn(() => 'researcher'),
}));

function decl(budgetOverrides: Partial<HarnessDeclaration['harness']['budget']> = {}): HarnessDeclaration {
  return {
    harness: {
      name: 'monitoring-budget-test-harness', schemaVersion: 1, primaryLane: 'research',
      budget: { maxTokens: 20000, maxToolCalls: 10, maxWallMinutes: 30, supervisorShareMax: 0.9, ...budgetOverrides },
      approval: { timeoutMinutes: 60, standingRules: [] },
    },
    roles: { researcher: { triggers: [], tools: [{ tool: 'cyber_tool' }] } },
    writes: [],
    contentDepth: { order: ['abstract', 'html', 'pdf'], default: 'abstract' },
    handoff: { schemaVersion: 1, lowConfidenceThreshold: 0.7, maxDepth: 3 },
  };
}

describe('monitoring — attach-time budget gating (integration)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-monitoring-budget-test-'));
    vi.clearAllMocks();
    cyberToolMock.mockResolvedValue({ success: true });
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('never attaches (never calls cyberTool) when maxToolCalls is already 0 — same gate as gatedCall, no exception for detached work', async () => {
    currentDecl = decl({ maxToolCalls: 0 });
    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('budget-attach-1', tmpDir);

    await deployHarness({ runId: 'budget-attach-1', goal: 'scan target', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);

    expect(cyberToolMock).not.toHaveBeenCalled();
    expect(run?.status).toBe('paused_budget');
    expect(run?.pendingMonitor).toBeUndefined(); // never got far enough to attach
  });
});

describe('monitoring — mid-flight wall-clock budget (integration)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-monitoring-wallclock-test-'));
    vi.clearAllMocks();
    cyberToolMock.mockResolvedValue({ success: true });
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('pauses paused_budget on resume when maxWallMinutes has elapsed while still monitoring', async () => {
    currentDecl = decl({ maxWallMinutes: 1 });
    const { deployHarness, resumeHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('budget-wallclock-1', tmpDir);

    await deployHarness({ runId: 'budget-wallclock-1', goal: 'scan target', workspaceRoot: tmpDir });
    const attached = await waitForSettled(store);
    expect(attached?.status).toBe('monitoring');

    // Simulate real elapsed time without a real sleep.
    const run = await store.loadRun();
    run!.createdAt = Date.now() - 5 * 60 * 1000; // 5 minutes ago, past the 1-minute limit
    await store.saveRun(run!);

    // The monitor is still genuinely running — this exercises the mid-flight
    // budget path, not the "done" completion path.
    expect(MonitorRegistry.get(attached!.pendingMonitor!.monitorId)?.status).toBe('running');

    const resumed = await resumeHarness('budget-wallclock-1', tmpDir);
    expect(resumed.status).toBe('paused_budget');
    expect(resumed.error).toContain('Wall-clock budget exceeded');
    expect(resumed.pendingMonitor).toBeDefined(); // kept, not cleared — a future budget-pause resume could still find its way back

    const events = await store.readTrace();
    expect(events.some(e => e.type === 'budget' && (e.data as any).reason === 'maxWallMinutes exceeded' && (e.data as any).monitorId)).toBe(true);
  });

  it('does not pause when still within the wall-clock budget', async () => {
    currentDecl = decl({ maxWallMinutes: 999 });
    const { deployHarness, resumeHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('budget-wallclock-2', tmpDir);

    await deployHarness({ runId: 'budget-wallclock-2', goal: 'scan target', workspaceRoot: tmpDir });
    await waitForSettled(store);

    const resumed = await resumeHarness('budget-wallclock-2', tmpDir);
    expect(resumed.status).toBe('monitoring'); // still running, still within budget -> plain no-op
  });
});
