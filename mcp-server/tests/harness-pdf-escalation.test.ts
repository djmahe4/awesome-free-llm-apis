import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import type { HarnessDeclaration } from '../src/harness/types.js';
import { waitForSettled } from './helpers/wait-for-run.js';

// P4b pdf branch — the piece explicitly deferred when the html branch
// shipped (docs/plans/2026-09-29-harness-p4-subagents-brain.md's P4b status
// note). Deviates from D6's own sketch (pdf_read as one of researcher's own
// tools): a `.pdf`/`pdf://` source is a distinct pseudo-role ('pdf'), same
// precedent as 'scraper' for html, so the existing task-id-is-the-role-name
// invariant (P4a) holds without any role ever running twice in one lane.

const useFreeLLMMock = vi.fn();
const resolvePdfRefMock = vi.fn();

vi.mock('../src/tools/use-free-llm.js', () => ({
  useFreeLLM: (...args: any[]) => useFreeLLMMock(...args),
  resolvePdfRef: (...args: any[]) => resolvePdfRefMock(...args),
}));

let currentDecl: HarnessDeclaration;
vi.mock('../src/harness/declaration.js', () => ({
  loadHarnessDeclaration: vi.fn(async () => currentDecl),
  selectRole: vi.fn(() => 'researcher'),
}));

function declWithPdf(lowConfidenceThreshold = 0.99): HarnessDeclaration {
  return {
    harness: {
      name: 'pdf-test-harness', schemaVersion: 1, primaryLane: 'research',
      budget: { maxTokens: 20000, maxToolCalls: 10, maxWallMinutes: 10, supervisorShareMax: 0.2 },
      approval: { timeoutMinutes: 60, standingRules: [] },
    },
    roles: {
      researcher: { triggers: [], tools: [{ tool: 'use_free_llm', constraints: { agentic: false } }] },
      pdf: { tools: [{ tool: 'pdf_read' }] },
    },
    writes: [],
    contentDepth: { order: ['abstract', 'html', 'pdf'], default: 'abstract' },
    handoff: { schemaVersion: 1, lowConfidenceThreshold, maxDepth: 3 },
  };
}

describe('pdf escalation (integration)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-pdf-test-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('escalates to a pdf step when confidence is low and a pdf:// ref is present, resolving via resolvePdfRef', async () => {
    useFreeLLMMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'See pdf://papers/cap-theorem.pdf:3 for the full proof.' } }],
    });
    resolvePdfRefMock.mockResolvedValueOnce({ resolvedContent: 'Full proof text from page 3.', imagePath: null, imageBase64: null });

    currentDecl = declWithPdf(0.99);
    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('pdf-1', tmpDir);

    await deployHarness({ runId: 'pdf-1', goal: 'find the CAP theorem proof', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);

    expect(resolvePdfRefMock).toHaveBeenCalledTimes(1);
    expect(resolvePdfRefMock.mock.calls[0][0]).toBe('papers/cap-theorem.pdf:3');
    expect(run?.status).toBe('complete');
    expect(run?.result).toContain('Full proof text from page 3');

    const events = await store.readTrace();
    const handoffs = events.filter(e => e.type === 'handoff').map(e => e.data as any);
    expect(handoffs).toHaveLength(2);
    expect(handoffs[0].to).toBe('pdf');
    expect(handoffs[1].from).toBe('pdf');

    const toolCalls = events.filter(e => e.type === 'tool_call').map(e => (e.data as any).tool);
    expect(toolCalls).toContain('pdf_read');
  });

  it('prefers pdf over html escalation when both a pdf ref and a URL are present', async () => {
    useFreeLLMMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'See https://example.com/paper and pdf://local/paper.pdf for details.' } }],
    });
    resolvePdfRefMock.mockResolvedValueOnce({ resolvedContent: 'PDF content wins.', imagePath: null, imageBase64: null });

    currentDecl = {
      ...declWithPdf(0.99),
      roles: { ...declWithPdf(0.99).roles, scraper: { tools: [{ tool: 'browser_tool', actions: ['navigate', 'extract'] }] } },
    };

    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('pdf-2', tmpDir);

    await deployHarness({ runId: 'pdf-2', goal: 'g', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);

    expect(resolvePdfRefMock).toHaveBeenCalledTimes(1);
    expect(run?.status).toBe('complete');
    expect(run?.result).toContain('PDF content wins');
  });

  it('does not escalate to pdf when confidence is high enough', async () => {
    useFreeLLMMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'A confident finding citing pdf://local/paper.pdf as a source.' } }],
    });
    currentDecl = declWithPdf(0);

    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('pdf-3', tmpDir);

    await deployHarness({ runId: 'pdf-3', goal: 'g', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);

    expect(resolvePdfRefMock).not.toHaveBeenCalled();
    expect(run?.status).toBe('complete');
  });

  it('a resolvePdfRef miss (null) fails the pdf step cleanly via the existing silent-zero handling, not a thrown error', async () => {
    useFreeLLMMock.mockResolvedValueOnce({ choices: [{ message: { content: 'See pdf://missing/file.pdf here.' } }] });
    resolvePdfRefMock.mockResolvedValueOnce(null);

    currentDecl = declWithPdf(0.99);
    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('pdf-4', tmpDir);

    await deployHarness({ runId: 'pdf-4', goal: 'g', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);

    expect(run?.status).toBe('failed');
  });
});
