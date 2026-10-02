import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import type { HarnessDeclaration } from '../src/harness/types.js';
import { waitForSettled } from './helpers/wait-for-run.js';

// Verifies runRoleStep actually dispatches by the role's DECLARED tool
// instead of always calling use_free_llm regardless of what the YAML says —
// the exact gap found by this session's multi-angle audit (policy.evaluate()
// already matched any declared tool name fine; the runner just never routed
// to anything but use_free_llm).

const useFreeLLMMock = vi.fn(async () => ({ choices: [{ message: { content: 'should not be called' } }] }));
const loadSkillPromptMock = vi.fn(async () => ({ success: true, skills: [{ name: 'mock-skill' }] }));
const executeSkillMock = vi.fn(async () => ({ success: true, response: 'mock skill executed' }));

vi.mock('../src/tools/use-free-llm.js', () => ({ useFreeLLM: useFreeLLMMock }));
vi.mock('../src/tools/load-skill-prompt.js', () => ({ loadSkillPrompt: loadSkillPromptMock }));
vi.mock('../src/tools/execute-skill.js', () => ({ executeSkill: executeSkillMock }));

let currentDecl: HarnessDeclaration;

vi.mock('../src/harness/declaration.js', () => ({
  loadHarnessDeclaration: vi.fn(async () => currentDecl),
  selectRole: vi.fn(() => 'researcher'),
}));

function makeDecl(tool: string): HarnessDeclaration {
  return {
    harness: {
      name: 'dispatch-test-harness', schemaVersion: 1, primaryLane: 'research',
      budget: { maxTokens: 10000, maxToolCalls: 5, maxWallMinutes: 10, supervisorShareMax: 0.2 },
      approval: { timeoutMinutes: 60, standingRules: [] },
    },
    roles: { researcher: { triggers: [], tools: [{ tool }] } }, // no constraints — allowed immediately
    writes: [],
    contentDepth: { order: ['abstract', 'html', 'pdf'], default: 'abstract' },
    handoff: { schemaVersion: 1, lowConfidenceThreshold: 0.7, maxDepth: 3 },
  };
}

describe('harness runner — role-declared tool dispatch (integration)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-dispatch-test-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('dispatches to load_skill_prompt when the role declares it, not use_free_llm', async () => {
    currentDecl = makeDecl('load_skill_prompt');
    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');

    await deployHarness({ runId: 'disp-1', goal: 'find a research skill', workspaceRoot: tmpDir });
    const store = new HarnessStore('disp-1', tmpDir);
    const run = await waitForSettled(store);

    // loadSkillPromptMock's result has no .prompt/.response — no content
    // field applyResearchResult knows how to extract — so this is correctly
    // 'failed' (silent-zero fix), not a false 'complete' with an empty
    // run.result indistinguishable from a real finding. Called twice, not
    // once: P4e's bounded trial-and-error retry (default maxAttemptsPerStep
    // 2) re-attempts once on the same empty-content failure before giving up.
    expect(loadSkillPromptMock).toHaveBeenCalledTimes(2);
    expect(useFreeLLMMock).not.toHaveBeenCalled();
    expect(run?.status).toBe('failed');

    const events = await store.readTrace();
    const toolCallEvent = events.find(e => e.type === 'tool_call');
    expect((toolCallEvent?.data as any)?.tool).toBe('load_skill_prompt');
  });

  it('dispatches to execute_skill when the role declares it, not use_free_llm', async () => {
    currentDecl = makeDecl('execute_skill');
    const { deployHarness } = await import('../src/harness/runner.js');

    await deployHarness({ runId: 'disp-2', goal: 'run a skill', workspaceRoot: tmpDir });
    const { HarnessStore } = await import('../src/harness/store.js');
    const store = new HarnessStore('disp-2', tmpDir);
    const run = await waitForSettled(store);

    expect(executeSkillMock).toHaveBeenCalledTimes(1);
    expect(useFreeLLMMock).not.toHaveBeenCalled();

    // executeSkillMock's result carries content under .response, not
    // .choices[0].message.content — completes successfully (multi-shape
    // extraction), not a false empty-content failure.
    expect(run?.status).toBe('complete');
    expect(run?.result).toBe('mock skill executed');
  });

  it('still dispatches to use_free_llm when the role declares it (unchanged default path)', async () => {
    currentDecl = makeDecl('use_free_llm');
    const { deployHarness } = await import('../src/harness/runner.js');

    await deployHarness({ runId: 'disp-3', goal: 'research something', workspaceRoot: tmpDir });
    const { HarnessStore } = await import('../src/harness/store.js');
    await waitForSettled(new HarnessStore('disp-3', tmpDir));

    expect(useFreeLLMMock).toHaveBeenCalledTimes(1);
    expect(loadSkillPromptMock).not.toHaveBeenCalled();
    expect(executeSkillMock).not.toHaveBeenCalled();
  });

  it('an unrecognized declared tool name never throws — falls back to the use_free_llm executor, but policy still gates on the ROLE\'S ACTUAL declared tool name, so it correctly parks for approval rather than silently executing under a mismatched allowlist', async () => {
    currentDecl = makeDecl('some_future_tool_not_in_dispatch_map');
    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');

    await deployHarness({ runId: 'disp-4', goal: 'g', workspaceRoot: tmpDir });
    await waitForSettled(new HarnessStore('disp-4', tmpDir));

    // Not executed — the resolved executor is use_free_llm, but the role's
    // allowlist only names 'some_future_tool_not_in_dispatch_map', so policy
    // correctly finds no matching rule and gates it. This is the SAFE
    // outcome: an unmapped tool name never silently runs under a different
    // tool's identity.
    expect(useFreeLLMMock).not.toHaveBeenCalled();

    const store = new HarnessStore('disp-4', tmpDir);
    const run = await store.loadRun();
    expect(run?.status).toBe('paused_approval');
    expect(run?.status).not.toBe('failed'); // never throws
  });
});
