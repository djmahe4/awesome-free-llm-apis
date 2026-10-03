import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { agentHarness } from '../src/tools/agent-harness.js';
import { HarnessStore } from '../src/harness/store.js';
import { loadHarnessDeclaration } from '../src/harness/declaration.js';
import { hashArgs } from '../src/harness/policy.js';

// A2 characterization: the `approvals` action loads the declaration with the
// run's OWN workspaceRoot (so a workspace-owned declaration supplies
// harness.approval.timeoutMinutes) instead of a hardcoded/builtin stand-in.
// The behavioral proof is expiry: a pending approval older than the builtin
// 60-minute default must SURVIVE when the run's declaration says 777.

vi.mock('../src/harness/declaration.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/harness/declaration.js')>();
  return {
    ...actual,
    loadHarnessDeclaration: vi.fn((...args: Parameters<typeof actual.loadHarnessDeclaration>) =>
      actual.loadHarnessDeclaration(...args)),
  };
});

describe('A2 — approvals uses the run workspaceRoot for declaration lookup', () => {
  let tmpDir: string;
  let wsDir: string;

  beforeEach(async () => {
    vi.mocked(loadHarnessDeclaration).mockClear();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'approvals-ws-test-'));
    wsDir = path.join(tmpDir, 'workspace');
    await fs.ensureDir(path.join(wsDir, 'harness'));
    await fs.writeFile(path.join(wsDir, 'harness', 'custom-h.yaml'), [
      'harness:',
      '  name: custom-h',
      '  approval:',
      '    timeoutMinutes: 777',
      'roles:',
      '  researcher: { triggers: [], tools: [{ tool: use_free_llm }] }',
      '',
    ].join('\n'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('loads the declaration with (declarationName, run.workspaceRoot) and honors its timeout', async () => {
    const store = new HarnessStore('run-appr', tmpDir);
    await store.saveRun({
      runId: 'run-appr', harness: 'custom-h', declarationName: 'custom-h', goal: 'g',
      workspaceRoot: wsDir, status: 'running',
      budget: { maxTokens: 100, used: 0, reserved: 0, toolCalls: 0 },
      createdAt: Date.now(), updatedAt: Date.now(),
    });

    const req = await store.createApproval({
      runId: 'run-appr', callId: 'call-1', role: 'researcher', tool: 'coding_agents',
      args: { goal: 'x' }, argsHash: hashArgs({ goal: 'x' }), reason: 'gated',
    });

    // Backdate to 70 minutes old: past the builtin 60-minute default,
    // well inside the workspace declaration's 777-minute timeout.
    const approvalsFile = path.join(tmpDir, '.free-llm-mcp', 'harness', 'run-appr', 'approvals.json');
    const list = await fs.readJson(approvalsFile);
    const target = list.find((a: { id: string }) => a.id === req.id);
    expect(target).toBeDefined();
    target.createdAt = Date.now() - 70 * 60_000;
    await fs.writeJson(approvalsFile, list, { spaces: 2 });

    const result = await agentHarness({ action: 'approvals', runId: 'run-appr', workspace_root: tmpDir });

    expect(loadHarnessDeclaration).toHaveBeenCalledWith('custom-h', wsDir);
    expect((result as { approvals: Array<{ id: string; status: string }> }).approvals)
      .toHaveLength(1);
    expect((result as { approvals: Array<{ id: string; status: string }> }).approvals[0].status)
      .toBe('pending'); // 70min < 777min — would be 'expired' under a hardcoded 60
  });

  it('falls back to 60 minutes when the run has no declarationName context yet', async () => {
    // A run record that predates a declaration file (or references a builtin
    // name) still resolves — loadHarnessDeclaration gets the run's workspaceRoot
    // either way; here the declaration lives in the workspace harness dir.
    const store = new HarnessStore('run-appr2', tmpDir);
    await store.saveRun({
      runId: 'run-appr2', harness: 'custom-h', declarationName: 'custom-h', goal: 'g',
      workspaceRoot: wsDir, status: 'running',
      budget: { maxTokens: 100, used: 0, reserved: 0, toolCalls: 0 },
      createdAt: Date.now(), updatedAt: Date.now(),
    });

    const result = await agentHarness({ action: 'approvals', runId: 'run-appr2', workspace_root: tmpDir });
    expect(loadHarnessDeclaration).toHaveBeenCalledWith('custom-h', wsDir);
    expect(result).toHaveProperty('approvals');
  });
});
