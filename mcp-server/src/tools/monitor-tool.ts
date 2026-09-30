import { MonitorRegistry } from '../harness/monitor.js';
import { HarnessStore } from '../harness/store.js';
import { loadHarnessDeclaration } from '../harness/declaration.js';
import { evaluate, hashArgs } from '../harness/policy.js';

/**
 * Poll/stop surface for detached long-running processes attached via
 * gatedDetach (docs/plans/2026-09-29-harness-p5-monitor-tool.md, D2/D5).
 * Attach itself isn't a public action here — it happens inside the harness
 * step engine via gatedDetach, which already has the run/decl/role context
 * this tool would otherwise have to reconstruct just to start something.
 */
export interface MonitorToolInput {
  action: 'poll' | 'stop';
  monitorId: string;
  /** Required for 'stop' — whose request this is, for the same-role-self-service vs cross-role-needs-approval check (D5). */
  role?: string;
}

export interface MonitorToolResult {
  success: boolean;
  monitorId: string;
  status?: 'running' | 'done' | 'failed' | 'needs_approval';
  progress?: { completed: number; total?: number; lastEvent?: string };
  result?: unknown;
  error?: string;
}

export async function monitorTool(input: MonitorToolInput): Promise<MonitorToolResult> {
  const entry = MonitorRegistry.get(input.monitorId);
  if (!entry) {
    return { success: false, monitorId: input.monitorId, error: `No monitor found for id '${input.monitorId}'.` };
  }

  if (input.action === 'poll') {
    return {
      success: true,
      monitorId: entry.monitorId,
      status: entry.status,
      progress: entry.progress,
      result: entry.status === 'done' ? entry.result : undefined,
      error: entry.status === 'failed' ? entry.error : undefined,
    };
  }

  // action === 'stop'
  if (!input.role) {
    return { success: false, monitorId: input.monitorId, error: "stop requires `role` (whose request this is)." };
  }
  if (entry.status !== 'running') {
    return { success: true, monitorId: entry.monitorId, status: entry.status }; // already finished — stop is a no-op, not an error
  }

  // Same-role self-service: the role that attached this monitor can stop it
  // without a fresh policy check — it already passed gatedDetach's gate to
  // attach in the first place. Cross-role stop goes through the same
  // allow/needs_approval/deny decision any other call would.
  if (input.role !== entry.role) {
    const store = new HarnessStore(entry.runId, entry.workspaceRoot);
    const run = await store.loadRun();
    if (!run) return { success: false, monitorId: input.monitorId, error: `Monitor's run '${entry.runId}' no longer exists.` };
    const decl = await loadHarnessDeclaration(run.declarationName, run.workspaceRoot);
    const args = { monitorId: entry.monitorId, action: 'stop' };
    const argsHash = hashArgs(args);
    const decision = evaluate(decl, input.role, entry.tool, 'stop', args);
    if (decision.kind === 'deny') {
      return { success: false, monitorId: input.monitorId, error: decision.reason };
    }
    if (decision.kind === 'needs_approval') {
      const callId = `stop:${entry.monitorId}`;
      const approved = await store.findApprovedFor(entry.runId, callId, argsHash);
      if (!approved) {
        const pending = (await store.listApprovals()).find(
          a => a.runId === entry.runId && a.callId === callId && a.argsHash === argsHash && a.status === 'pending'
        );
        if (!pending) {
          await store.createApproval({ runId: entry.runId, callId, role: input.role, tool: entry.tool, action: 'stop', args, argsHash, reason: decision.reason });
        }
        return { success: false, monitorId: input.monitorId, status: 'needs_approval', error: decision.reason };
      }
    }
  }

  MonitorRegistry.finish(entry.monitorId, undefined, 'stopped');
  return { success: true, monitorId: entry.monitorId, status: 'failed' };
}
