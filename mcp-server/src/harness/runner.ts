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
 *
 * `args` MUST be the real payload the call executes with (not a stand-in) —
 * it's both what's hashed for approval-binding AND what a human reviews in
 * the approval record. A prior version hashed a hardcoded placeholder while
 * `execute()` closed over the real (different) arguments, so an approval
 * never actually bound to what ran.
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
    await store.appendTrace({ runId: run.runId, role, type: 'budget', data: { reason: 'max tool calls reached' } });
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
    // Bound strictly to this run+call+exact-args-hash — never re-matched by
    // tool name alone, and never satisfied by an approval granted for a
    // differently-hashed payload (e.g. a different goal on a later resume).
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
  } catch (err: any) {
    // A thrown tool call previously left NO tool_result trace at all — the
    // audit log looked identical to a call that was never attempted.
    await store.appendTrace({ runId: run.runId, role, type: 'tool_result', data: { tool, callId, ok: false, error: err?.message || String(err) } }).catch(() => {});
    throw err;
  } finally {
    run.budget.reserved -= estimatedTokens;
  }
}

/** The single research step both deploy and resume execute — factored out so a resume re-attempts with the IDENTICAL real payload (same argsHash) an approval was granted for. */
async function runResearchStep(
  store: HarnessStore,
  run: HarnessRun,
  decl: HarnessDeclaration,
  role: string,
  goal: string,
  workspaceRoot: string | undefined,
  registryKey: string
): Promise<GatedResult> {
  const { useFreeLLM } = await import('../tools/use-free-llm.js');
  const goalTokens = contextManager.countStringTokens(goal);
  const estimate = goalTokens + 2000; // rough input+output reserve for one research call

  // This exact object is both hashed for approval-binding and passed to
  // useFreeLLM — one source of truth, so what a human approves is what runs.
  const payload = {
    messages: [
      { role: 'system', content: 'You are a research agent. Answer with grounded findings only; cite sources inline. Do not fabricate citations.' },
      { role: 'user', content: goal },
    ],
    agentic: false,
    workspace_root: workspaceRoot,
    sessionId: registryKey,
    isOnePass: true,
  };

  return gatedCall(
    store, run, decl, role, 'use_free_llm', undefined, payload, estimate, 'research-1',
    async () => useFreeLLM(payload as any)
  );
}

function applyResearchResult(run: HarnessRun, role: string, callResult: GatedResult, goalTokens: number, aborted: boolean): { content?: string } {
  if (aborted) {
    run.status = 'aborted';
    return {};
  }
  if (!callResult.ok) {
    run.status = callResult.reason === 'needs_approval' ? 'paused_approval' : 'paused_budget';
    run.error = callResult.detail;
    return {};
  }
  const content: string = callResult.result?.choices?.[0]?.message?.content ?? '';
  run.budget.used += contextManager.countStringTokens(content) + goalTokens;
  run.result = content;
  run.status = 'complete';
  return { content };
}

async function finalizeRun(store: HarnessStore, run: HarnessRun, role: string, registryKey: string, content: string | undefined): Promise<void> {
  if (content !== undefined) {
    await store.appendTrace({
      runId: run.runId, role, type: 'handoff', data: {
        from: role, to: 'top_level', status: 'complete', confidence: 0.7,
        findings: [{ claim: content.slice(0, 500), source: 'use_free_llm' }],
        openQuestions: [], artifacts: [], nextAction: 'none', requiresApproval: { needed: false },
      },
    }).catch(() => {});
  }
  run.updatedAt = Date.now();
  await store.saveRun(run).catch(() => {});
  await store.appendTrace({ runId: run.runId, role: 'top_level', type: 'run_end', data: { status: run.status } }).catch(() => {});
  // Report the actual terminal state, not just failed/not-failed — a
  // paused/aborted run previously reported as "finished successfully" to
  // the registry even though run.json disagreed.
  const registryError = run.status === 'complete' ? undefined : run.status === 'failed' ? run.error : `run ended with status '${run.status}'`;
  RunRegistry.finish(registryKey, registryError);
}

/**
 * Deploys (starts) a background harness run: single-role research flow —
 * selects a role by goal-text triggers, asks use_free_llm for grounded
 * findings, and records a handoff. This is the P3 vertical slice (one role,
 * no multi-agent handoff chain yet — see docs/plans/2026-09-29-agent-harness.md P4).
 * Runs detached (RunRegistry-backed); `deploy` returns immediately with the
 * initial 'running' run record — poll with action:'status'.
 *
 * Refuses a runId that already has a persisted run — redeploying over an
 * existing run silently reset its budget/toolCalls counters and could
 * execute a differently-hashed payload under an approval granted for the
 * original goal. Use `resumeHarness` to continue a paused run instead.
 */
export async function deployHarness(input: DeployInput): Promise<HarnessRun> {
  const store = new HarnessStore(input.runId, input.workspaceRoot);
  const existing = await store.loadRun();
  if (existing) {
    throw new Error(`Run '${input.runId}' already exists (status: ${existing.status}). Use action:'resume' to continue a paused run, or deploy with a different runId.`);
  }

  const decl = await loadHarnessDeclaration(input.harness);
  const role = selectRole(decl, input.goal);
  const registryKey = `harness:${input.runId}`;

  const run: HarnessRun = {
    runId: input.runId,
    harness: decl.harness.name,
    declarationName: input.harness ?? 'research-analysis',
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
      const goalTokens = contextManager.countStringTokens(input.goal);
      const callResult = await runResearchStep(store, run, decl, role, input.goal, input.workspaceRoot, registryKey);
      const { content } = applyResearchResult(run, role, callResult, goalTokens, runInfo.controller.signal.aborted);
      await finalizeRun(store, run, role, registryKey, content);
    } catch (err: any) {
      run.status = 'failed';
      run.error = err?.message || String(err);
      await store.appendTrace({ runId: run.runId, role: 'top_level', type: 'error', data: { message: run.error } }).catch(() => {});
      await finalizeRun(store, run, role, registryKey, undefined);
    }
  })().catch(() => {});

  return run;
}

/**
 * Resumes a run parked in `paused_approval` after its pending call was
 * approved — re-enters gatedCall with the IDENTICAL goal/payload the
 * approval was hashed against, so it now finds the approved record instead
 * of parking again. This is the piece that was entirely missing: approving
 * a request previously had no effect because nothing ever re-invoked the
 * gated call afterward.
 */
export async function resumeHarness(runId: string, workspaceRoot?: string): Promise<HarnessRun> {
  const store = new HarnessStore(runId, workspaceRoot);
  const run = await store.loadRun();
  if (!run) throw new Error(`No run found for runId '${runId}'`);
  if (run.status !== 'paused_approval') {
    throw new Error(`Run '${runId}' is not paused for approval (status: '${run.status}')`);
  }

  const decl = await loadHarnessDeclaration(run.declarationName);
  const role = selectRole(decl, run.goal);
  const registryKey = `harness:${runId}`;

  run.status = 'running';
  run.error = undefined;
  await store.saveRun(run);

  const runInfo = RunRegistry.start(registryKey);

  (async () => {
    try {
      const goalTokens = contextManager.countStringTokens(run.goal);
      const callResult = await runResearchStep(store, run, decl, role, run.goal, run.workspaceRoot, registryKey);
      const { content } = applyResearchResult(run, role, callResult, goalTokens, runInfo.controller.signal.aborted);
      await finalizeRun(store, run, role, registryKey, content);
    } catch (err: any) {
      run.status = 'failed';
      run.error = err?.message || String(err);
      await store.appendTrace({ runId: run.runId, role: 'top_level', type: 'error', data: { message: run.error } }).catch(() => {});
      await finalizeRun(store, run, role, registryKey, undefined);
    }
  })().catch(() => {});

  return run;
}

export function abortHarness(runId: string): boolean {
  return RunRegistry.abort(`harness:${runId}`);
}
