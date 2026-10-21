import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import type { HarnessDeclaration, HarnessRun } from '../src/harness/types.js';
import { MonitorRegistry } from '../src/harness/monitor.js';

// P5a — gatedDetach + monitor_tool (attach/poll/stop) against a fake
// process (docs/plans/2026-09-29-harness-p5-monitor-tool.md). Attach itself
// isn't a public MCP action — it's exercised directly here, matching how
// the harness step engine would call it once a real detached step type
// exists (P5b, not yet wired).
//
// monitor-tool.ts's cross-role stop path calls the REAL loadHarnessDeclaration
// (it needs the run's declaration to policy-gate a stop from a role that
// didn't attach the monitor) — mocked here so it returns the same in-memory
// decl object the test itself constructed, instead of trying to read a YAML
// file that doesn't exist for a fake declaration name.
let currentDecl: HarnessDeclaration;
vi.mock('../src/harness/declaration.js', () => ({
  loadHarnessDeclaration: vi.fn(async () => currentDecl),
}));

function makeDecl(scraperConstraints: Record<string, unknown> = {}): HarnessDeclaration {
  return {
    harness: {
      name: 'monitor-test-harness', schemaVersion: 1, primaryLane: 'research',
      budget: { maxTokens: 20000, maxToolCalls: 10, maxWallMinutes: 30, supervisorShareMax: 0.5 },
      approval: { timeoutMinutes: 60, standingRules: [] },
    },
    roles: { scraper: { tools: [{ tool: 'browser_tool', ...(Object.keys(scraperConstraints).length ? { constraints: scraperConstraints } : {}) }] } },
    writes: [],
    contentDepth: { order: ['abstract', 'html', 'pdf'], default: 'abstract' },
    handoff: { schemaVersion: 1, lowConfidenceThreshold: 0.7, maxDepth: 3 },
  };
}

function makeRun(overrides: Partial<HarnessRun> = {}): HarnessRun {
  return {
    runId: 'mon-run-1', harness: 'monitor-test-harness', declarationName: 'monitor-test-harness',
    goal: 'g', status: 'running',
    budget: { maxTokens: 20000, used: 0, reserved: 0, toolCalls: 0 },
    createdAt: Date.now(), updatedAt: Date.now(),
    ...overrides,
  };
}

describe('gatedDetach (unit)', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-test-'));
    currentDecl = makeDecl();
  });
  afterEach(async () => { await fs.remove(tmpDir); });

  it('returns immediately with a monitorId without awaiting the underlying process, and registers it', async () => {
    const { gatedDetach } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');

    const store = new HarnessStore('mon-run-1', tmpDir);
    const run = makeRun({ workspaceRoot: tmpDir });

    let started = false;
    const start = vi.fn(async () => {
      started = true;
      return { handle: 'fake-scan-123' };
    });

    const result = await gatedDetach(store, run, currentDecl, 'scraper', 'browser_tool', 'deep_scrape', { target: 'x' }, 500, 's0:scraper:scan', start);

    expect(result.ok).toBe(true);
    expect(started).toBe(true);
    if (result.ok) {
      expect(result.monitorId).toBe('s0:scraper:scan');
      const entry = MonitorRegistry.get(result.monitorId);
      expect(entry).toBeDefined();
      expect(entry?.status).toBe('running');
      expect(entry?.handle).toBe('fake-scan-123');
    }

    const events = await store.readTrace();
    expect(events.some(e => e.type === 'monitor_attached')).toBe(true);
  });

  it('parks on needs_approval without ever calling start() — same gate as gatedCall, no exception for detached work', async () => {
    const { gatedDetach } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');

    const store = new HarnessStore('mon-run-2', tmpDir);
    const run = makeRun({ runId: 'mon-run-2', workspaceRoot: tmpDir });
    // constraint the real args won't satisfy -> needs_approval
    currentDecl = makeDecl({ requiresSomethingElse: true });

    const start = vi.fn(async () => ({ handle: 'never' }));
    const result = await gatedDetach(store, run, currentDecl, 'scraper', 'browser_tool', 'deep_scrape', { target: 'x' }, 500, 's0:scraper:scan', start);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('needs_approval');
    expect(start).not.toHaveBeenCalled();

    const approvals = await store.listApprovals();
    expect(approvals).toHaveLength(1);
  });

  it('denies without calling start() when the role has no matching allowlist rule at all', async () => {
    const { gatedDetach } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');

    const store = new HarnessStore('mon-run-3', tmpDir);
    const run = makeRun({ runId: 'mon-run-3', workspaceRoot: tmpDir });
    currentDecl = { ...makeDecl(), roles: {} }; // role doesn't exist at all -> policy.evaluate 'deny'

    const start = vi.fn(async () => ({ handle: 'never' }));
    const result = await gatedDetach(store, run, currentDecl, 'scraper', 'browser_tool', 'deep_scrape', { target: 'x' }, 500, 's0:scraper:scan', start);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('denied');
    expect(start).not.toHaveBeenCalled();
  });
});

describe('monitor_tool — poll/stop (integration)', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-tool-test-'));
    currentDecl = makeDecl();
  });
  afterEach(async () => { await fs.remove(tmpDir); });

  it('poll reflects progress reported by the underlying process', async () => {
    const { gatedDetach } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const { monitorTool } = await import('../src/tools/monitor-tool.js');

    const store = new HarnessStore('mon-run-4', tmpDir);
    const run = makeRun({ runId: 'mon-run-4', workspaceRoot: tmpDir });

    const attach = await gatedDetach(store, run, currentDecl, 'scraper', 'browser_tool', 'deep_scrape', { target: 'x' }, 500, 's0:scraper:scan', async () => ({ handle: 'h1' }));
    expect(attach.ok).toBe(true);
    if (!attach.ok) return;

    let polled = await monitorTool({ action: 'poll', monitorId: attach.monitorId });
    expect(polled.status).toBe('running');

    MonitorRegistry.reportProgress(attach.monitorId, { completed: 3, total: 10, lastEvent: 'found candidate' });
    polled = await monitorTool({ action: 'poll', monitorId: attach.monitorId });
    expect(polled.progress).toEqual({ completed: 3, total: 10, lastEvent: 'found candidate' });

    MonitorRegistry.finish(attach.monitorId, { hits: 3 });
    polled = await monitorTool({ action: 'poll', monitorId: attach.monitorId });
    expect(polled.status).toBe('done');
    expect(polled.result).toEqual({ hits: 3 });
  });

  it('stop is self-service for the attaching role, no approval needed', async () => {
    const { gatedDetach } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const { monitorTool } = await import('../src/tools/monitor-tool.js');

    const store = new HarnessStore('mon-run-5', tmpDir);
    const run = makeRun({ runId: 'mon-run-5', workspaceRoot: tmpDir });

    const attach = await gatedDetach(store, run, currentDecl, 'scraper', 'browser_tool', 'deep_scrape', { target: 'x' }, 500, 's0:scraper:scan', async () => ({ handle: 'h1' }));
    if (!attach.ok) throw new Error('attach failed');

    const stopped = await monitorTool({ action: 'stop', monitorId: attach.monitorId, role: 'scraper' });
    expect(stopped.success).toBe(true);
    expect(stopped.status).toBe('failed');
    expect(MonitorRegistry.get(attach.monitorId)?.error).toBe('stopped');
  });

  it('stop from a different role with no matching allowlist rule is denied, never actually stopping the monitor', async () => {
    const { gatedDetach } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const { monitorTool } = await import('../src/tools/monitor-tool.js');

    const store = new HarnessStore('mon-run-6', tmpDir);
    const run = makeRun({ runId: 'mon-run-6', workspaceRoot: tmpDir });
    await store.saveRun(run); // monitor-tool's cross-role path reloads the run by id

    const attach = await gatedDetach(store, run, currentDecl, 'scraper', 'browser_tool', 'deep_scrape', { target: 'x' }, 500, 's0:scraper:scan', async () => ({ handle: 'h1' }));
    if (!attach.ok) throw new Error('attach failed');

    // 'coder' has no role entry at all in currentDecl -> policy denies.
    const stopped = await monitorTool({ action: 'stop', monitorId: attach.monitorId, role: 'coder' });
    expect(stopped.success).toBe(false);
    expect(MonitorRegistry.get(attach.monitorId)?.status).toBe('running'); // never actually stopped
  });

  it('poll on an unknown monitorId fails cleanly', async () => {
    const { monitorTool } = await import('../src/tools/monitor-tool.js');
    const result = await monitorTool({ action: 'poll', monitorId: 'does-not-exist' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('No monitor found');
  });
});

describe('MonitorRegistry.markAllOrphaned (D5 boot reconciliation)', () => {
  it('marks a still-running entry failed with an orphaned reason', () => {
    MonitorRegistry.attach('orphan-test-1', 'run-x', 'scraper', 'browser_tool', 'h1');
    const orphaned = MonitorRegistry.markAllOrphaned();
    expect(orphaned.some(e => e.monitorId === 'orphan-test-1')).toBe(true);
    expect(MonitorRegistry.get('orphan-test-1')?.status).toBe('failed');
    expect(MonitorRegistry.get('orphan-test-1')?.error).toBe('orphaned on restart');
  });

  it('does not touch an already-finished entry', () => {
    MonitorRegistry.attach('orphan-test-2', 'run-x', 'scraper', 'browser_tool', 'h2');
    MonitorRegistry.finish('orphan-test-2', { ok: true });
    MonitorRegistry.markAllOrphaned();
    expect(MonitorRegistry.get('orphan-test-2')?.status).toBe('done');
  });
});
