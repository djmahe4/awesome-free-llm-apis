import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import type { HarnessDeclaration } from '../src/harness/types.js';
import { waitForSettled } from './helpers/wait-for-run.js';

// P4b — research depth ladder (docs/plans/2026-09-29-harness-p4-subagents-brain.md).
// This slice: deterministic abstract->html escalation only (pdf branch
// explicitly deferred). Escalates when the researcher step's real,
// COMPUTED confidence (buildHandoff — short content stays well under 1)
// falls below the declaration's lowConfidenceThreshold AND a fetchable URL
// is present in its findings; otherwise the ladder stops at abstract.

const useFreeLLMMock = vi.fn();
const dispatchBrowserActionMock = vi.fn();

vi.mock('../src/tools/use-free-llm.js', () => ({ useFreeLLM: (...args: any[]) => useFreeLLMMock(...args) }));
vi.mock('../src/browser/dispatch.js', () => ({ dispatchBrowserAction: (...args: any[]) => dispatchBrowserActionMock(...args) }));

let currentDecl: HarnessDeclaration;
vi.mock('../src/harness/declaration.js', () => ({
  loadHarnessDeclaration: vi.fn(async () => currentDecl),
  selectRole: vi.fn(() => 'researcher'),
}));

function declWithScraper(lowConfidenceThreshold = 0.99): HarnessDeclaration {
  return {
    harness: {
      name: 'ladder-test-harness', schemaVersion: 1, primaryLane: 'research',
      budget: { maxTokens: 20000, maxToolCalls: 10, maxWallMinutes: 10, supervisorShareMax: 0.2 },
      approval: { timeoutMinutes: 60, standingRules: [] },
    },
    roles: {
      researcher: { triggers: [], tools: [{ tool: 'use_free_llm', constraints: { agentic: false } }] },
      scraper: { triggers: [], tools: [{ tool: 'browser_tool', actions: ['navigate', 'extract'] }] },
    },
    writes: [],
    contentDepth: { order: ['abstract', 'html', 'pdf'], default: 'abstract' },
    handoff: { schemaVersion: 1, lowConfidenceThreshold, maxDepth: 3 },
  };
}

describe('research depth ladder — abstract to html escalation (integration)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-ladder-test-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('escalates to a scraper step when confidence is below threshold and a URL is present', async () => {
    // A high threshold (0.99) guarantees buildHandoff's computed confidence
    // (capped well under 1 for short content) falls below it.
    useFreeLLMMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'Some sources mention https://example.com/paper for more detail.' } }],
    });
    dispatchBrowserActionMock
      .mockResolvedValueOnce({ success: true, status: 'ok', action: 'navigate', sessionId: 'x', data: null, confidence: 1, recordCount: 0, errors: [], warnings: [], usedPersistedScript: false, usedSiteMemory: false })
      .mockResolvedValueOnce({ success: true, status: 'ok', action: 'extract', sessionId: 'x', data: 'Full page content extracted from example.com.', confidence: 0.9, recordCount: 1, errors: [], warnings: [], usedPersistedScript: false, usedSiteMemory: false });

    currentDecl = declWithScraper(0.99);
    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');

    const store = new HarnessStore('ladder-1', tmpDir);
    await deployHarness({ runId: 'ladder-1', goal: 'find info on the paper', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);

    expect(dispatchBrowserActionMock).toHaveBeenCalledTimes(2);
    expect(dispatchBrowserActionMock.mock.calls[0][0]).toMatchObject({ action: 'navigate', url: 'https://example.com/paper' });
    expect(dispatchBrowserActionMock.mock.calls[1][0]).toMatchObject({ action: 'extract' });

    expect(run?.status).toBe('complete');
    expect(run?.result).toContain('Full page content extracted');

    const events = await store.readTrace();
    const handoffs = events.filter(e => e.type === 'handoff').map(e => e.data as any);
    expect(handoffs).toHaveLength(2);
    expect(handoffs[0].to).toBe('scraper'); // routed to the escalated step, not straight to top_level
    expect(handoffs[1].from).toBe('scraper');

    const tasks = events.filter(e => e.type === 'tool_call').map(e => (e.data as any).tool);
    expect(tasks).toContain('browser_tool');
  });

  it('stops at abstract when confidence is at/above threshold — no scraper call at all', async () => {
    useFreeLLMMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'A confident, grounded, well-supported finding with citation https://example.com/x' } }],
    });
    currentDecl = declWithScraper(0); // threshold 0 -> any non-empty content clears it

    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('ladder-2', tmpDir);

    await deployHarness({ runId: 'ladder-2', goal: 'g', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);

    expect(dispatchBrowserActionMock).not.toHaveBeenCalled();
    expect(run?.status).toBe('complete');

    const events = await store.readTrace();
    expect(events.filter(e => e.type === 'handoff')).toHaveLength(1);
  });

  it('does not escalate when confidence is low but no URL is present — nothing to fetch', async () => {
    useFreeLLMMock.mockResolvedValueOnce({ choices: [{ message: { content: 'A short answer with no links at all.' } }] });
    currentDecl = declWithScraper(0.99);

    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('ladder-3', tmpDir);

    await deployHarness({ runId: 'ladder-3', goal: 'g', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);

    expect(dispatchBrowserActionMock).not.toHaveBeenCalled();
    expect(run?.status).toBe('complete');
  });

  it('does not escalate when the declaration has no scraper role at all', async () => {
    useFreeLLMMock.mockResolvedValueOnce({ choices: [{ message: { content: 'Low confidence but see https://example.com/y' } }] });
    currentDecl = { ...declWithScraper(0.99), roles: { researcher: declWithScraper().roles.researcher } };

    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('ladder-4', tmpDir);

    await deployHarness({ runId: 'ladder-4', goal: 'g', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);

    expect(dispatchBrowserActionMock).not.toHaveBeenCalled();
    expect(run?.status).toBe('complete');
  });
});
