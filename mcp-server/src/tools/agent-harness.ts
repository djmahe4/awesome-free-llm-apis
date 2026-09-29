import crypto from 'node:crypto';
import { deployHarness, abortHarness } from '../harness/runner.js';
import { HarnessStore } from '../harness/store.js';

export interface AgentHarnessInput {
  action: 'deploy' | 'status' | 'approvals' | 'approve' | 'reject' | 'trace' | 'abort';
  runId?: string;              // required for all actions except deploy (which generates one)
  harness?: string;            // declaration name, default 'research-analysis'
  goal?: string;                // required for deploy
  workspace_root?: string;
  maxTokens?: number;
  approvalId?: string;         // required for approve/reject
  note?: string;
  limit?: number;              // for trace
}

export async function agentHarness(input: AgentHarnessInput) {
  switch (input.action) {
    case 'deploy': {
      if (!input.goal) throw new Error('deploy requires `goal`.');
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
      await store.expireStale(60);
      return { approvals: await store.listApprovals() };
    }
    case 'approve':
    case 'reject': {
      if (!input.runId) throw new Error(`${input.action} requires \`runId\`.`);
      if (!input.approvalId) throw new Error(`${input.action} requires \`approvalId\`.`);
      const store = new HarnessStore(input.runId, input.workspace_root);
      const decided = await store.decideApproval(input.approvalId, input.action === 'approve', 'user', input.note);
      if (!decided) return { success: false, error: `No approval found with id '${input.approvalId}'` };
      return { success: true, approval: decided };
    }
    case 'trace': {
      if (!input.runId) throw new Error('trace requires `runId`.');
      const store = new HarnessStore(input.runId, input.workspace_root);
      return { events: await store.readTrace(input.limit ?? 200) };
    }
    case 'abort': {
      if (!input.runId) throw new Error('abort requires `runId`.');
      const aborted = abortHarness(input.runId);
      return { success: aborted };
    }
    default:
      throw new Error(`Unsupported action: ${(input as any).action}`);
  }
}
