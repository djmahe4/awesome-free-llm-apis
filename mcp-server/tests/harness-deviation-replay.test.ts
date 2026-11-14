import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import type { HarnessRun, TraceEvent } from '../src/harness/types.js';

const mockValidate = vi.fn(async (_input: { goal: string; trace: Array<{ text: string }>; proposed: string }) => ({
  alignment: 'aligned' as const,
  drift_prob: 0,
  unsafe_prob: 0,
  latency_ms: 1,
}));
const mockEnforce = vi.fn((_result: unknown) => 'proceed' as const);

vi.mock('../src/harness/laya-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    validateThoughtDeviation: (input: { goal: string; trace: Array<{ text: string }>; proposed: string }) => mockValidate(input),
    enforceDeviationPolicy: (result: unknown) => mockEnforce(result),
  };
});

vi.mock('../src/tools/use-free-llm.js', () => ({
  useFreeLLM: vi.fn(async () => ({ choices: [{ message: { content: 'Mocked.' } }] })),
}));

vi.mock('../src/harness/declaration.js', () => ({
  loadHarnessDeclaration: vi.fn(async () => ({})),
  selectRole: vi.fn(() => 'researcher'),
}));

async function makeWriter(datasetDir: string) {
  const { ThoughtDatasetWriter } = await import('../src/harness/thought-dataset-writer.js');
  return new ThoughtDatasetWriter({ outputDir: datasetDir });
}

function seedEvent(type: TraceEvent['type'], data: Record<string, unknown>) {
  return { runId: 'rp-1', role: 'researcher', type, data };
}

describe('checkThoughtDeviation — trace-truncation dataset replay', () => {
  let tmpDir: string;
  let datasetDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deviation-replay-'));
    datasetDir = path.join(tmpDir, 'dataset');
    vi.clearAllMocks();
    vi.stubEnv('THOUGHT_DATASET_DIR', datasetDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('non-truncated run trails from the trace tail with trail_source=trace', async () => {
    const { checkThoughtDeviation } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('rp-1', tmpDir);
    await store.appendTrace(seedEvent('tool_result', { callId: 'c1', ok: true }));
    await store.appendTrace(seedEvent('tool_result', { callId: 'c2', ok: true }));

    const run = { runId: 'rp-1' } as unknown as HarnessRun;
    await checkThoughtDeviation(store, run, 'researcher', 'goal text', 'proposed action', 'call-9');

    expect(mockValidate).toHaveBeenCalledTimes(1);
    const input = mockValidate.mock.calls[0][0] ;
    expect(input.goal).toBe('goal text');
    expect(input.proposed).toBe('proposed action');
    expect(input.trace.every(t => typeof t.text === 'string')).toBe(true);
    expect(input.trace[0].text).toContain('tool_result');

    const events = await store.readTrace();
    const deviation = events.find(e => e.type === 'deviation') as any;
    expect(deviation.data.trail_source).toBe('trace');
    expect(deviation.data.callId).toBe('call-9');
    expect(deviation.data.policy).toBe('proceed');
  });

  it('truncated run replays dataset rows for this runId with trail_source=dataset_replay', async () => {
    const { checkThoughtDeviation } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const writer = await makeWriter(datasetDir);
    await writer.append({ thought: { id: 'rp-1:c1', text: 'look at trace format', source: 'rea', timestamp: 1 }, tool: 'browser_tool', action: 'navigate', goal: 'g', alignment: 'aligned', drift_prob: 0 });
    await writer.append({ thought: { id: 'other-run:c1', text: 'not this run', source: 'rea', timestamp: 2 }, tool: 'browser_tool', action: 'navigate', goal: 'g', alignment: 'aligned', drift_prob: 0 });
    await writer.append({ thought: { id: 'rp-1:c2', text: 'replay the tail', source: 'rea', timestamp: 3 }, tool: 'websearch', action: 'search', goal: 'g', alignment: 'aligned', drift_prob: 0 });

    const store = new HarnessStore('rp-1', tmpDir);
    await store.appendTrace(seedEvent('tool_result', { callId: 'c1', ok: true }));
    await store.appendTrace(seedEvent('trace_truncated', { maxBytes: 5 * 1024 * 1024 }));

    const run = { runId: 'rp-1' } as unknown as HarnessRun;
    await checkThoughtDeviation(store, run, 'researcher', 'goal text', 'proposed action', 'call-9');

    const input = mockValidate.mock.calls[0][0] ;
    expect(input.trace).toHaveLength(2);
    expect(input.trace[0].text).toMatch(/^thought\(browser_tool\): look at trace format/);
    expect(input.trace[1].text).toMatch(/^thought\(websearch\): replay the tail/);

    const events = await store.readTrace();
    const deviation = events.find(e => e.type === 'deviation') as any;
    expect(deviation.data.trail_source).toBe('dataset_replay');
  });

  it('truncated run with no dataset rows falls back to the trace tail', async () => {
    const { checkThoughtDeviation } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('rp-1', tmpDir);
    await store.appendTrace(seedEvent('tool_result', { callId: 'c1', ok: true }));
    await store.appendTrace(seedEvent('trace_truncated', { maxBytes: 5 * 1024 * 1024 }));

    const run = { runId: 'rp-1' } as unknown as HarnessRun;
    await checkThoughtDeviation(store, run, 'researcher', 'goal text', 'proposed action', 'call-9');

    const input = mockValidate.mock.calls[0][0] ;
    expect(input.trace[0].text).toContain('tool_result');

    const events = await store.readTrace();
    const deviation = events.find(e => e.type === 'deviation') as any;
    expect(deviation.data.trail_source).toBe('trace');
  });
});
