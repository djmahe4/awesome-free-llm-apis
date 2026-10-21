import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { assertWorkspaceRootAllowed } from '../src/harness/policy.js';
import type { HarnessDeclaration } from '../src/harness/types.js';
import { waitForSettled } from './helpers/wait-for-run.js';

vi.mock('../src/tools/use-free-llm.js', () => ({
  useFreeLLM: vi.fn(async () => ({ choices: [{ message: { content: 'Mocked research finding.' } }] })),
}));

let tmpProjectDir: string;

// This declaration's role allowlist matches the runner's real payload
// (agentic:false), so the call succeeds on the first attempt without
// needing approval — isolates the task-lifecycle assertions from the
// approval-flow ones already covered in agent-harness-runner.test.ts.
function makeAllowedDecl(allowedWorkspaceRoots: string[] = []): HarnessDeclaration {
  return {
    harness: {
      name: 'scoped-test-harness', schemaVersion: 1, primaryLane: 'research',
      budget: { maxTokens: 10000, maxToolCalls: 5, maxWallMinutes: 10, supervisorShareMax: 0.2 },
      approval: { timeoutMinutes: 60, standingRules: [] },
      allowedWorkspaceRoots,
    },
    roles: {
      researcher: { triggers: [], tools: [{ tool: 'use_free_llm', constraints: { agentic: false } }] },
    },
    writes: [],
    contentDepth: { order: ['abstract', 'html', 'pdf'], default: 'abstract' },
    handoff: { schemaVersion: 1, lowConfidenceThreshold: 0.7, maxDepth: 3 },
  };
}

vi.mock('../src/harness/declaration.js', () => ({
  loadHarnessDeclaration: vi.fn(async () => (globalThis as any).__testDecl),
  selectRole: vi.fn(() => 'researcher'),
}));

describe('policy — workspace root scoping', () => {
  it('allows any workspace_root when allowedWorkspaceRoots is unset/empty', () => {
    const decl = makeAllowedDecl([]);
    expect(() => assertWorkspaceRootAllowed(decl, '/anywhere/at/all')).not.toThrow();
    expect(() => assertWorkspaceRootAllowed(decl, undefined)).not.toThrow();
  });

  it('rejects a workspace_root outside the declared allowlist', () => {
    const decl = makeAllowedDecl([path.join('C:', 'projects', 'approved-project')]);
    expect(() => assertWorkspaceRootAllowed(decl, path.join('C:', 'projects', 'other-project'))).toThrow(/not permitted/);
  });

  it('rejects a missing workspace_root when the declaration requires one', () => {
    const decl = makeAllowedDecl([path.join('C:', 'projects', 'approved-project')]);
    expect(() => assertWorkspaceRootAllowed(decl, undefined)).toThrow(/requires workspace_root/);
  });

  it('allows an exact match and a subdirectory of an allowed root', () => {
    const root = path.join('C:', 'projects', 'approved-project');
    const decl = makeAllowedDecl([root]);
    expect(() => assertWorkspaceRootAllowed(decl, root)).not.toThrow();
    expect(() => assertWorkspaceRootAllowed(decl, path.join(root, 'sub', 'dir'))).not.toThrow();
  });

  it('does not allow a sibling directory with a matching prefix (e.g. approved-project-2)', () => {
    const root = path.join('C:', 'projects', 'approved-project');
    const decl = makeAllowedDecl([root]);
    // Naive `startsWith` (without the path.sep boundary) would wrongly allow this.
    expect(() => assertWorkspaceRootAllowed(decl, root + '-2')).toThrow(/not permitted/);
  });
});

describe('harness runner — workspace scoping enforcement (integration)', () => {
  beforeEach(async () => {
    tmpProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-scope-test-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.remove(tmpProjectDir);
  });

  it('deploy refuses a workspace_root outside the declared allowlist', async () => {
    (globalThis as any).__testDecl = makeAllowedDecl([path.join('C:', 'some', 'other', 'approved', 'path')]);
    const { deployHarness } = await import('../src/harness/runner.js');
    await expect(deployHarness({ runId: 'ws-1', goal: 'g', workspaceRoot: tmpProjectDir }))
      .rejects.toThrow(/not permitted/);
  });

  it('deploy succeeds when workspace_root is inside the declared allowlist', async () => {
    (globalThis as any).__testDecl = makeAllowedDecl([tmpProjectDir]);
    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const run = await deployHarness({ runId: 'ws-2', goal: 'g', workspaceRoot: tmpProjectDir });
    expect(run.status).toBe('running');
    // Let the detached background work settle before afterEach removes
    // tmpProjectDir — otherwise the in-flight write races the directory
    // removal (ENOTEMPTY), a test-cleanup race, not a bug in the code under test.
    await waitForSettled(new HarnessStore('ws-2', tmpProjectDir));
  });
});

describe('harness runner — tasks.md blackboard (integration)', () => {
  beforeEach(async () => {
    tmpProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-tasks-test-'));
    (globalThis as any).__testDecl = makeAllowedDecl([]); // unrestricted for these tests
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.remove(tmpProjectDir);
  });

  it('creates a tasks.md entry for the selected role and marks it completed on success', async () => {
    const { deployHarness } = await import('../src/harness/runner.js');
    const { agentHarness } = await import('../src/tools/agent-harness.js');
    const { HarnessStore } = await import('../src/harness/store.js');

    await deployHarness({ runId: 'tk-1', goal: 'research the CAP theorem', workspaceRoot: tmpProjectDir });
    await waitForSettled(new HarnessStore('tk-1', tmpProjectDir));

    const { tasksFile, tasks } = await agentHarness({ action: 'tasks', runId: 'tk-1', workspace_root: tmpProjectDir }) as { tasksFile: string | null; tasks: any[] };
    expect(tasksFile).toContain('research the CAP theorem');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('researcher');
    expect(tasks[0].status).toBe('completed');
    expect(tasks[0].log?.length).toBeGreaterThanOrEqual(2); // one "attempting" entry, one outcome entry
  });

  it('returns an empty task list for a run that never deployed', async () => {
    const { agentHarness } = await import('../src/tools/agent-harness.js');
    const { tasksFile, tasks } = await agentHarness({ action: 'tasks', runId: 'no-such-run', workspace_root: tmpProjectDir }) as { tasksFile: string | null; tasks: any[] };
    expect(tasksFile).toBeNull();
    expect(tasks).toEqual([]);
  });

  it('leaves the task \'pending\' (not \'completed\') through a paused_approval attempt, then marks it completed on resume — matching coding_agents\' own blackboard rule that a failed/paused attempt must stay retryable', async () => {
    // A constraint the runner's real payload (agentic:false) does not
    // satisfy, forcing needs_approval on the first attempt.
    (globalThis as any).__testDecl = {
      ...makeAllowedDecl([]),
      roles: { researcher: { triggers: [], tools: [{ tool: 'use_free_llm', constraints: { agentic: true } }] } },
    };

    const { deployHarness, resumeHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const { agentHarness } = await import('../src/tools/agent-harness.js');

    const store = new HarnessStore('tk-2', tmpProjectDir);
    await deployHarness({ runId: 'tk-2', goal: 'goal needing approval', workspaceRoot: tmpProjectDir });
    await waitForSettled(store);

    const afterDeploy = await agentHarness({ action: 'tasks', runId: 'tk-2', workspace_root: tmpProjectDir });
    expect((afterDeploy as any).tasks[0].status).toBe('pending'); // paused, not completed — must stay retryable

    const [pending] = await store.listApprovals();
    await store.decideApproval(pending.id, true, 'user');
    await resumeHarness('tk-2', tmpProjectDir);
    await waitForSettled(store);

    const afterResume = await agentHarness({ action: 'tasks', runId: 'tk-2', workspace_root: tmpProjectDir });
    expect((afterResume as any).tasks[0].status).toBe('completed');
    expect((afterResume as any).tasks[0].log?.length).toBeGreaterThanOrEqual(4); // 2 attempts x (start + outcome)
  });
});
