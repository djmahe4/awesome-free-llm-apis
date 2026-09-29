import { RunRegistry } from '../pipeline/middlewares/RunRegistry.js';
import { ContextManager } from '../utils/ContextManager.js';
import { HarnessStore } from './store.js';
import { loadHarnessDeclaration, selectRole } from './declaration.js';
import { evaluate, hashArgs } from './policy.js';
import type { HarnessDeclaration, HarnessRun } from './types.js';

const contextManager = new ContextManager();

export interface DeployInput {
  runId: string;
  harness?: string;
  goal: string;
  workspaceRoot?: string;
  maxTokens?: number;
}

type GatedResult =
  | { ok: true; result: any }
  | { ok: false; reason: 'needs_approval' | 'budget' | 'denied'; detail: string };

/**
 * Gated tool-call wrapper — every tool invocation the harness makes goes
 * through this, not directly through the tool function. Order matters:
 * budget is checked before policy so a denied/pending call never counts
 * against the tool-call cap, and policy is checked before the reserved
 * tokens are committed so a needs_approval call reserves nothing.
 */
export async function gatedCall(
  store: HarnessStore,
  run: HarnessRun,
  decl: HarnessDeclaration,
  role: string,
  tool: string,
  action: string | undefined,
  args: any,
  estimatedTokens: number,
  callId: string,
  execute: () => Promise<any>
): Promise<GatedResult> {
  await store.appendTrace({ runId: run.runId, role, type: 'tool_call', data: { tool, action, callId } });

  if (run.budget.used + run.budget.reserved + estimatedTokens > run.budget.maxTokens) {
    await store.appendTrace({ runId: run.runId, role, type: 'budget', data: { reason: 'would exceed maxTokens', estimatedTokens, remaining: run.budget.maxTokens - run.budget.used - run.budget.reserved } });
    return { ok: false, reason: 'budget', detail: 'Token budget would be exceeded by this call' };
  }
  if (run.budget.toolCalls + 1 > decl.harness.budget.maxToolCalls) {
    return { ok: false, reason: 'budget', detail: 'Max tool call count reached for this run' };
  }

  const argsHash = hashArgs(args);
  const decision = evaluate(decl, role, tool, action, args);
  await store.appendTrace({ runId: run.runId, role, type: 'policy_decision', data: { tool, action, callId, decision: decision.kind } });

  if (decision.kind === 'deny') {
    return { ok: false, reason: 'denied', detail: decision.reason };
  }

  if (decision.kind === 'needs_approval') {
    await store.expireStale(decl.harness.approval.timeoutMinutes);
    // Bound strictly to this run+call+exact-args — never re-matched by tool name alone.
    const approved = await store.findApprovedFor(run.runId, callId, argsHash);
    if (!approved) {
      const pending = (await store.listApprovals()).find(
        a => a.runId === run.runId && a.callId === callId && a.argsHash === argsHash && a.status === 'pending'
      );
      if (!pending) {
        await store.createApproval({ runId: run.runId, callId, role, tool, action, args, argsHash, reason: decision.reason });
        await store.appendTrace({ runId: run.runId, role, type: 'approval_requested', data: { tool, action, callId, reason: decision.reason } });
      }
      return { ok: false, reason: 'needs_approval', detail: decision.reason };
    }
    await store.appendTrace({ runId: run.runId, role, type: 'approval_decided', data: { tool, action, callId, status: 'approved' } });
  }

  run.budget.reserved += estimatedTokens;
  run.budget.toolCalls += 1;
  try {
    const result = await execute();
    await store.appendTrace({ runId: run.runId, role, type: 'tool_result', data: { tool, callId, ok: true } });
    return { ok: true, result };
  } finally {
    run.budget.reserved -= estimatedTokens;
  }
}

/**
 * Deploys (starts) a background harness run: single-role research flow —
 * selects a role by goal-text triggers, asks use_free_llm for grounded
 * findings, and records a handoff. This is the P3 vertical slice (one role,
 * no multi-agent handoff chain yet — see docs/plans/2026-09-29-agent-harness.md P4).
 * Runs detached (RunRegistry-backed); `deploy` returns immediately with the
 * initial 'running' run record — poll with action:'status'.
 */
export async function deployHarness(input: DeployInput): Promise<HarnessRun> {
  const decl = await loadHarnessDeclaration(input.harness);
  const store = new HarnessStore(input.runId, input.workspaceRoot);
  const role = selectRole(decl, input.goal);
  const registryKey = `harness:${input.runId}`;

  const run: HarnessRun = {
    runId: input.runId,
    harness: decl.harness.name,
    goal: input.goal,
    workspaceRoot: input.workspaceRoot,
    status: 'running',
    budget: {
      maxTokens: input.maxTokens ?? decl.harness.budget.maxTokens,
      used: 0,
      reserved: 0,
      toolCalls: 0,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await store.saveRun(run);
  await store.appendTrace({ runId: run.runId, role: 'top_level', type: 'run_start', data: { goal: input.goal, role } });

  const runInfo = RunRegistry.start(registryKey);

  (async () => {
    try {
      const { useFreeLLM } = await import('../tools/use-free-llm.js');
      const goalTokens = contextManager.countStringTokens(input.goal);
      const estimate = goalTokens + 2000; // rough input+output reserve for one research call

      const callResult = await gatedCall(
        store, run, decl, role, 'use_free_llm', undefined, { agentic: false }, estimate, 'research-1',
        async () => useFreeLLM({
          messages: [
            { role: 'system', content: 'You are a research agent. Answer with grounded findings only; cite sources inline. Do not fabricate citations.' },
            { role: 'user', content: input.goal },
          ],
          agentic: false,
          workspace_root: input.workspaceRoot,
          sessionId: registryKey,
          isOnePass: true,
        } as any)
      );

      if (runInfo.controller.signal.aborted) {
        run.status = 'aborted';
      } else if (!callResult.ok) {
        run.status = callResult.reason === 'needs_approval' ? 'paused_approval' : 'paused_budget';
        run.error = callResult.detail;
      } else {
        const content: string = callResult.result?.choices?.[0]?.message?.content ?? '';
        run.budget.used += contextManager.countStringTokens(content) + goalTokens;
        run.result = content;
        run.status = 'complete';
        await store.appendTrace({
          runId: run.runId, role, type: 'handoff', data: {
            from: role, to: 'top_level', status: 'complete', confidence: 0.7,
            findings: [{ claim: content.slice(0, 500), source: 'use_free_llm' }],
            openQuestions: [], artifacts: [], nextAction: 'none', requiresApproval: { needed: false },
          },
        });
      }
    } catch (err: any) {
      run.status = 'failed';
      run.error = err?.message || String(err);
      await store.appendTrace({ runId: run.runId, role: 'top_level', type: 'error', data: { message: run.error } }).catch(() => {});
    } finally {
      run.updatedAt = Date.now();
      await store.saveRun(run).catch(() => {});
      await store.appendTrace({ runId: run.runId, role: 'top_level', type: 'run_end', data: { status: run.status } }).catch(() => {});
      RunRegistry.finish(registryKey, run.status === 'failed' ? run.error : undefined);
    }
  })().catch(() => {});

  return run;
}

export function abortHarness(runId: string): boolean {
  return RunRegistry.abort(`harness:${runId}`);
}
