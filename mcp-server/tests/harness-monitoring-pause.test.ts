import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import type { HarnessDeclaration } from '../src/harness/types.js';
import { waitForSettled } from './helpers/wait-for-run.js';
import { MonitorRegistry } from '../src/harness/monitor.js';

// P5b + the real step-engine design gap fix: 'monitoring' is now a
// first-class run status (not a repurposing of paused_approval/
// paused_budget), with its own resume semantics via resumeMonitoredRun.
// cyber_tool's osint autoSearch is the concrete detached user (a role
// whose declared tool is 'cyber_tool' attaches via gatedDetach instead of
// completing synchronously).

const cyberToolMock = vi.fn(async () => ({ success: true }));
vi.mock('../src/tools/cyber-tool.js', () => ({ cyberTool: (...args: any[]) => cyberToolMock(...args) }));

let currentDecl: HarnessDeclaration;
vi.mock('../src/harness/declaration.js', () => ({
  loadHarnessDeclaration: vi.fn(async () => currentDecl),
  selectRole: vi.fn(() => 'researcher'),
}));

function decl(): HarnessDeclaration {
  return {
    harness: {
      name: 'monitoring-test-harness', schemaVersion: 1, primaryLane: 'research',
      budget: { maxTokens: 20000, maxToolCalls: 10, maxWallMinutes: 30, supervisorShareMax: 0.9 },
      approval: { timeoutMinutes: 60, standingRules: [] },
    },
    roles: { researcher: { triggers: [], tools: [{ tool: 'cyber_tool' }] } },
    writes: [],
    contentDepth: { order: ['abstract', 'html', 'pdf'], default: 'abstract' },
    handoff: { schemaVersion: 1, lowConfidenceThreshold: 0.7, maxDepth: 3 },
  };
}

describe('monitoring pause + resume (integration)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-monitoring-test-'));
    vi.clearAllMocks();
    cyberToolMock.mockResolvedValue({ success: true });
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('deploy attaches and pauses the run as monitoring, without waiting for the scan to finish', async () => {
    currentDecl = decl();
    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('monitor-run-1', tmpDir);

    await deployHarness({ runId: 'monitor-run-1', goal: 'scan example.com', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);

    expect(run?.status).toBe('monitoring');
    expect(run?.pendingMonitor?.monitorId).toBeDefined();
    expect(cyberToolMock).toHaveBeenCalledTimes(1);

    const entry = MonitorRegistry.get(run!.pendingMonitor!.monitorId);
    expect(entry?.status).toBe('running');

    const events = await store.readTrace();
    expect(events.some(e => e.type === 'monitor_attached')).toBe(true);
  });

  it('resume is a no-op while the monitor is still running', async () => {
    currentDecl = decl();
    const { deployHarness, resumeHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('monitor-run-2', tmpDir);

    await deployHarness({ runId: 'monitor-run-2', goal: 'scan example.com', workspaceRoot: tmpDir });
    await waitForSettled(store);

    const resumed = await resumeHarness('monitor-run-2', tmpDir);
    expect(resumed.status).toBe('monitoring'); // still monitoring — no-op
  });

  it('resume completes the run once the monitor finishes with a result', async () => {
    currentDecl = decl();
    const { deployHarness, resumeHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('monitor-run-3', tmpDir);

    await deployHarness({ runId: 'monitor-run-3', goal: 'scan example.com', workspaceRoot: tmpDir });
    const paused = await waitForSettled(store);
    const monitorId = paused!.pendingMonitor!.monitorId;

    MonitorRegistry.finish(monitorId, { hits: ['a', 'b'] });

    await resumeHarness('monitor-run-3', tmpDir);
    const run = await waitForSettled(store);

    expect(run?.status).toBe('complete');
    expect(run?.result).toContain('hits');
    expect(run?.pendingMonitor).toBeUndefined();

    const events = await store.readTrace();
    expect(events.some(e => e.type === 'monitor_done' && (e.data as any).status === 'done')).toBe(true);
    expect(events.filter(e => e.type === 'handoff')).toHaveLength(1);
  });

  it('resume fails the run cleanly when the monitor itself failed', async () => {
    currentDecl = decl();
    const { deployHarness, resumeHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('monitor-run-4', tmpDir);

    await deployHarness({ runId: 'monitor-run-4', goal: 'scan example.com', workspaceRoot: tmpDir });
    const paused = await waitForSettled(store);
    const monitorId = paused!.pendingMonitor!.monitorId;

    MonitorRegistry.finish(monitorId, undefined, 'scan provider unreachable');

    await resumeHarness('monitor-run-4', tmpDir);
    const run = await waitForSettled(store);

    expect(run?.status).toBe('failed');
    expect(run?.error).toContain('scan provider unreachable');
  });

  it('resume fails the run cleanly (never stuck forever) when the registry has lost the monitor entirely', async () => {
    currentDecl = decl();
    const { deployHarness, resumeHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('monitor-run-5', tmpDir);

    await deployHarness({ runId: 'monitor-run-5', goal: 'scan example.com', workspaceRoot: tmpDir });
    const paused = await waitForSettled(store);
    const monitorId = paused!.pendingMonitor!.monitorId;

    // Simulate a server restart losing the in-memory registry entirely: no
    // 'delete' API is exposed on MonitorRegistry (there's no real use for
    // one outside this exact test scenario), so this points the run at a
    // monitorId that was never attached — MonitorRegistry.get() returns
    // undefined for it exactly like a lost-on-restart entry would.
    void monitorId;
    const run0 = await store.loadRun();
    run0!.pendingMonitor = { monitorId: 'never-existed-id', stepIndex: 0, role: 'researcher' };
    await store.saveRun(run0!);

    await resumeHarness('monitor-run-5', tmpDir);
    const run = await waitForSettled(store);

    expect(run?.status).toBe('failed');
    expect(run?.error).toContain('no longer tracked');
  });
});
