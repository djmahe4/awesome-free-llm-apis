import crypto from 'node:crypto';
import { deployHarness, resumeHarness, abortHarness, reorchestrateRole } from '../harness/runner.js';
import { HarnessStore } from '../harness/store.js';
import { loadHarnessDeclaration } from '../harness/declaration.js';
import { parseTasksMarkdown } from './coding-agents.js';

export interface AgentHarnessInput {
  action: 'deploy' | 'resume' | 'rerun' | 'reorchestrate' | 'status' | 'approvals' | 'approve' | 'reject' | 'trace' | 'tasks' | 'abort';
  runId?: string;              // required for all actions except deploy (which generates one)
  harness?: string;            // declaration name (resolved from <workspace_root>/.free-llm-mcp/harness/, then legacy <workspace_root>/harness/, then built-in) or a .yaml path; default 'research-analysis'
  goal?: string;                // required for deploy
  workspace_root?: string;
  maxTokens?: number;
  maxWallMinutes?: number;     // resume only: raises the wall-clock cap of a run that paused on its budget (1-1440 minutes)
  approvalId?: string;         // required for approve/reject
  note?: string;
  limit?: number;              // for trace
  role?: string;               // for rerun/reorchestrate
  followupContext?: string;    // for rerun/reorchestrate
}

export async function agentHarness(input: AgentHarnessInput) {
  switch (input.action) {
    case 'deploy': {
      if (typeof input.goal !== 'string' || !input.goal.trim()) throw new Error('deploy requires `goal` (non-empty text).');
      if (input.goal.length > 20_000) throw new Error('`goal` is too long (limit 20000 characters); put the detail in a file and point to it.');
      if (input.maxTokens !== undefined && !(typeof input.maxTokens === 'number' && Number.isFinite(input.maxTokens) && input.maxTokens > 0)) {
        throw new Error('`maxTokens` must be a positive number.');
      }
      if (input.harness !== undefined && (typeof input.harness !== 'string' || input.harness.length > 500)) {
        throw new Error('`harness` must be a declaration name or .yaml path (text, up to 500 characters).');
      }
      const runId = input.runId || crypto.randomUUID();
      const run = await deployHarness({
        runId,
        harness: input.harness,
        goal: input.goal,
        workspaceRoot: input.workspace_root,
        maxTokens: input.maxTokens,
      });
      return { success: true, run };
    }
    case 'resume': {
      if (!input.runId) throw new Error('resume requires `runId`.');
      const run = await resumeHarness(input.runId, input.workspace_root, { maxWallMinutes: input.maxWallMinutes });
      if (run.status === 'monitoring') {
        return { success: true, run, note: 'The run is still waiting on its monitored process; nothing has advanced. Check monitor_tool, then resume again.' };
      }
      return { success: true, run };
    }
    case 'rerun':
    case 'reorchestrate': {
      if (!input.runId) throw new Error(`${input.action} requires \`runId\`.`);
      if (!input.role) throw new Error(`${input.action} requires \`role\`.`);
      const run = await reorchestrateRole({
        runId: input.runId,
        role: input.role,
        workspaceRoot: input.workspace_root,
        followupContext: input.followupContext,
      });
      return { success: true, run };
    }
    case 'status': {
      if (!input.runId) throw new Error('status requires `runId`.');
      const store = new HarnessStore(input.runId, input.workspace_root);
      const run = await store.loadRun();
      if (!run) return { success: false, error: `No run found for runId '${input.runId}'` };
      const approvals = await store.listApprovals();
      const pending = approvals.filter(a => a.status === 'pending');
      return { success: true, run, pendingApprovals: pending.length };
    }
    case 'approvals': {
      if (!input.runId) throw new Error('approvals requires `runId`.');
      const store = new HarnessStore(input.runId, input.workspace_root);
      if (!(await store.loadRun())) return { success: false, error: `No run found for runId '${input.runId}'` };
      // Use the run's own declared timeout rather than a hardcoded stand-in —
      // a declaration with a longer timeout was having its approvals expired
      // early just from listing them.
      const run = await store.loadRun();
      let timeoutMinutes = 60;
      let warning: string | undefined;
      if (run) {
        try {
          timeoutMinutes = (await loadHarnessDeclaration(run.declarationName, run.workspaceRoot)).harness.approval.timeoutMinutes;
        } catch (err: any) {
          // the declaration was moved or deleted after deploy: listing approvals must still work, so a human can see what is pending
          warning = `Declaration '${run.declarationName}' could not be loaded (${err?.message ?? err}); using the default ${timeoutMinutes}-minute approval timeout.`;
        }
      }
      await store.expireStale(timeoutMinutes);
      return warning ? { approvals: await store.listApprovals(), warning } : { approvals: await store.listApprovals() };
    }
    case 'approve':
    case 'reject': {
      if (!input.runId) throw new Error(`${input.action} requires \`runId\`.`);
      if (!input.approvalId) throw new Error(`${input.action} requires \`approvalId\`.`);
      const store = new HarnessStore(input.runId, input.workspace_root);
      if (!(await store.loadRun())) return { success: false, error: `No run found for runId '${input.runId}'` };
      const decided = await store.decideApproval(input.approvalId, input.action === 'approve', 'user', input.note);
      if (!decided) return { success: false, error: `No approval found with id '${input.approvalId}'` };
      if (decided.status !== (input.action === 'approve' ? 'approved' : 'rejected')) {
        return { success: false, error: `Approval '${input.approvalId}' is already ${decided.status}; it cannot be ${input.action === 'approve' ? 'approved' : 'rejected'}.`, approval: decided };
      }
      return { success: true, approval: decided };
    }
    case 'trace': {
      if (!input.runId) throw new Error('trace requires `runId`.');
      const store = new HarnessStore(input.runId, input.workspace_root);
      if (!(await store.loadRun())) return { success: false, error: `No run found for runId '${input.runId}'` };
      const limit = Number.isFinite(input.limit) ? Math.min(1000, Math.max(1, Math.floor(input.limit as number))) : 200;
      return { events: await store.readTrace(limit) };
    }
    case 'tasks': {
      if (!input.runId) throw new Error('tasks requires `runId`.');
      const store = new HarnessStore(input.runId, input.workspace_root);
      const raw = await store.loadTasksMarkdown();
      if (!raw) return { tasksFile: null, tasks: [] };
      return { tasksFile: raw, tasks: parseTasksMarkdown(raw) };
    }
    case 'abort': {
      if (!input.runId) throw new Error('abort requires `runId`.');
      if (abortHarness(input.runId)) return { success: true };
      // Not live in this process (server restarted, or the registry entry expired): the
      // persisted run is the truth. Cancel it there, or say exactly why nothing was cancelled.
      const store = new HarnessStore(input.runId, input.workspace_root);
      const persisted = await store.loadRun();
      if (!persisted) return { success: false, error: `No run '${input.runId}' found${input.workspace_root ? ` in ${input.workspace_root}` : ''}.` };
      if (persisted.status === 'complete' || persisted.status === 'failed' || persisted.status === 'aborted') {
        return { success: false, error: `Run '${input.runId}' is already ${persisted.status}; nothing to abort.` };
      }
      persisted.status = 'aborted';
      persisted.updatedAt = Date.now();
      await store.saveRun(persisted);
      await store.appendTrace({ runId: persisted.runId, role: 'top_level', type: 'error', data: { message: 'run aborted (no live process; persisted run cancelled)' } }).catch(() => {});
      return { success: true, note: 'Run was not live in this process; the persisted run was marked aborted.' };
    }
    default:
      throw new Error(`Unsupported action: ${(input as any).action}`);
  }
}
