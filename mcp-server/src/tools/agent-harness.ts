import crypto from 'node:crypto';
import { deployHarness, resumeHarness, abortHarness } from '../harness/runner.js';
import { HarnessStore } from '../harness/store.js';
import { loadHarnessDeclaration } from '../harness/declaration.js';

export interface AgentHarnessInput {
  action: 'deploy' | 'resume' | 'status' | 'approvals' | 'approve' | 'reject' | 'trace' | 'abort';
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
    case 'resume': {
      if (!input.runId) throw new Error('resume requires `runId`.');
      const run = await resumeHarness(input.runId, input.workspace_root);
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
      // Use the run's own declared timeout rather than a hardcoded stand-in —
      // a declaration with a longer timeout was having its approvals expired
      // early just from listing them.
      const run = await store.loadRun();
      const timeoutMinutes = run ? (await loadHarnessDeclaration(run.declarationName)).harness.approval.timeoutMinutes : 60;
      await store.expireStale(timeoutMinutes);
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
