/**
 * T5 — cyclic lane execution on top of T4's `harness.lane`/`maxCycles`.
 *
 * planSteps walks the declared lane once per allowed cycle: cycle 1 emits
 * plain phase ids, cycles ≥2 emit `phase#cN`, capped by laneCycleMax.
 * runSteps strips the suffix back to the BASE role for policy/handoff/traces
 * while tasks.md keeps the full plan id (so each cycle is its own task and
 * the resume cursor still works). Every lane step emits a `phase` trace.
 * Legacy declarations (no lane) are unchanged: same plan, no phase traces,
 * no `#cN` ids anywhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import type { HarnessDeclaration } from '../src/harness/types.js';
import { waitForSettled } from './helpers/wait-for-run.js';

const useFreeLLMMock = vi.fn();
vi.mock('../src/tools/use-free-llm.js', () => ({ useFreeLLM: (...args: any[]) => useFreeLLMMock(...args) }));

let currentDecl: HarnessDeclaration;
vi.mock('../src/harness/declaration.js', () => ({
  loadHarnessDeclaration: vi.fn(async () => currentDecl),
  selectRole: vi.fn(() => 'scanner'),
}));

function laneDecl(lane?: string[], maxCycles?: number): HarnessDeclaration {
  return {
    harness: {
      name: 'lane-phase-test-harness', schemaVersion: 1, primaryLane: 'appsec',
      budget: { maxTokens: 20000, maxToolCalls: 20, maxWallMinutes: 10, supervisorShareMax: 0.2 },
      approval: { timeoutMinutes: 60, standingRules: [] },
      ...(lane ? { lane } : {}),
      ...(maxCycles !== undefined ? { maxCycles } : {}),
    },
    roles: {
      scanner: { triggers: [], tools: [{ tool: 'use_free_llm', constraints: { agentic: false } }] },
      fixer: { triggers: [], tools: [{ tool: 'use_free_llm', constraints: { agentic: false } }] },
      analyst: { triggers: [], tools: [{ tool: 'use_free_llm', constraints: { agentic: false } }] },
    },
    writes: [],
    contentDepth: { order: ['abstract'], default: 'abstract' },
    handoff: { schemaVersion: 1, lowConfidenceThreshold: 0.7, maxDepth: 3 },
  };
}

describe('T5 cyclic lane execution', () => {
  let tmpDir: string;

  async function runLane(runId: string, decl: HarnessDeclaration) {
    useFreeLLMMock.mockResolvedValue({ choices: [{ message: { content: 'finding: session token rotated on login' } }] });
    currentDecl = decl;
    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore(runId, tmpDir);
    await deployHarness({ runId, goal: 'harden the session tokens', workspaceRoot: tmpDir });
    const run = await waitForSettled(store);
    return { run, store };
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-lane-phases-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('walks the lane once per allowed cycle: plan ids, real steps, tasks.md cursor', async () => {
    const { run } = await runLane('lane-phase-1', laneDecl(['scanner', 'fixer'], 2));

    expect(run?.status).toBe('complete');
    expect(useFreeLLMMock).toHaveBeenCalledTimes(4); // 2 phases × 2 cycles

    const { agentHarness } = await import('../src/tools/agent-harness.js');
    const { tasks } = (await agentHarness({ action: 'tasks', runId: 'lane-phase-1', workspace_root: tmpDir })) as any;
    expect(tasks.map((t: any) => t.id)).toEqual(['scanner', 'fixer', 'scanner#c2', 'fixer#c2']);
    expect(tasks.every((t: any) => t.status === 'completed')).toBe(true);
  });

  it('an explicit lane without maxCycles runs exactly one pass (implicit cap 1)', async () => {
    const { run } = await runLane('lane-phase-2', laneDecl(['scanner', 'fixer']));

    expect(run?.status).toBe('complete');
    expect(useFreeLLMMock).toHaveBeenCalledTimes(2);

    const { agentHarness } = await import('../src/tools/agent-harness.js');
    const { tasks } = (await agentHarness({ action: 'tasks', runId: 'lane-phase-2', workspace_root: tmpDir })) as any;
    expect(tasks.map((t: any) => t.id)).toEqual(['scanner', 'fixer']);
  });

  it('emits a phase trace per lane step (base phase, cycle, taskId, index, total)', async () => {
    const { store } = await runLane('lane-phase-3', laneDecl(['scanner', 'fixer'], 2));

    const events = await store.readTrace();
    const phases = events.filter(e => e.type === 'phase');
    expect(phases.map(e => e.role)).toEqual(['scanner', 'fixer', 'scanner', 'fixer']);
    expect(phases.map(e => e.data)).toEqual([
      { phase: 'scanner', cycle: 1, taskId: 'scanner', index: 0, total: 4 },
      { phase: 'fixer', cycle: 1, taskId: 'fixer', index: 1, total: 4 },
      { phase: 'scanner', cycle: 2, taskId: 'scanner#c2', index: 2, total: 4 },
      { phase: 'fixer', cycle: 2, taskId: 'fixer#c2', index: 3, total: 4 },
    ]);
  });

  it('strips the cycle suffix at execution: handoffs and policy see the base role', async () => {
    const decl = laneDecl(['scanner', 'fixer'], 2);
    const { run, store } = await runLane('lane-phase-4', decl);
    expect(run?.status).toBe('complete');

    const events = await store.readTrace();
    const handoffs = events.filter(e => e.type === 'handoff').map(e => e.data as any);
    expect(handoffs.map(h => h.from)).toEqual(['scanner', 'fixer', 'scanner', 'fixer']);
    expect(handoffs[1].to).toBe('scanner'); // plan id 'scanner#c2' hands off to the BASE role
    expect(handoffs[3].to).toBe('top_level');

    // Defense-in-depth: policy.evaluate accepts a suffixed id as its base role
    // (and still denies genuinely unknown roles).
    const { evaluate } = await import('../src/harness/policy.js');
    expect(evaluate(decl, 'scanner#c2', 'use_free_llm', undefined, { agentic: false }).kind).toBe('allow');
    expect(evaluate(decl, 'ghost#c2', 'use_free_llm', undefined, { agentic: false }).kind).toBe('deny');
  });

  it('legacy (no lane) declarations keep their original plan — no phase traces, no #cN ids', async () => {
    const { run, store } = await runLane('lane-phase-5', laneDecl());

    expect(run?.status).toBe('complete');
    expect(useFreeLLMMock).toHaveBeenCalledTimes(2); // selectRole primary + analyst, unchanged

    const { agentHarness } = await import('../src/tools/agent-harness.js');
    const { tasks } = (await agentHarness({ action: 'tasks', runId: 'lane-phase-5', workspace_root: tmpDir })) as any;
    expect(tasks.map((t: any) => t.id)).toEqual(['scanner', 'analyst']);

    const events = await store.readTrace();
    expect(events.filter(e => e.type === 'phase')).toHaveLength(0);
    expect(tasks.map((t: any) => t.id).join(',')).not.toContain('#c');
  });
});
