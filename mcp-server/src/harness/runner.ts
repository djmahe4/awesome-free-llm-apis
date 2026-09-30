import { RunRegistry } from '../pipeline/middlewares/RunRegistry.js';
import { ContextManager } from '../utils/ContextManager.js';
import { HarnessStore } from './store.js';
import { loadHarnessDeclaration, selectRole } from './declaration.js';
import { evaluate, hashArgs, assertWorkspaceRootAllowed } from './policy.js';
import { serializeTasksMarkdown, parseTasksMarkdown, type TaskItem } from '../tools/coding-agents.js';
import { CYBER_TERMS_REGEX } from '../utils/TaskClassifier.js';
import { buildHandoff, validateHandoff, type Handoff } from './handoff.js';
import type { HarnessDeclaration, HarnessRun } from './types.js';

const contextManager = new ContextManager();

/**
 * Reuses coding_agents' own tasks.md blackboard (see store.ts's
 * saveTasksMarkdown/loadTasksMarkdown) to track each role's attempts across
 * this run — same append-only per-task log, same pending/in_progress/
 * completed/failed semantics. In this P3 vertical slice there's exactly one
 * task (the single role selected for the run), but the mechanism is the
 * real one P4's multi-role handoff chain will add more tasks onto, not a
 * bespoke parallel tracker.
 */
async function loadOrInitTasks(store: HarnessStore, goal: string, role: string): Promise<TaskItem[]> {
  const raw = await store.loadTasksMarkdown();
  if (raw) return parseTasksMarkdown(raw);
  return [{ id: role, task: goal, status: 'pending', log: [] }];
}

async function saveTasks(store: HarnessStore, goal: string, tasks: TaskItem[]): Promise<void> {
  await store.saveTasksMarkdown(serializeTasksMarkdown(goal, tasks)).catch(() => {});
}

/**
 * Seeds tasks.md with one 'pending' task per planned step, in step order,
 * BEFORE any step runs — this is what makes tasks.md a real cursor: resume
 * can look at which of these already-declared tasks is the first
 * non-'completed' one, instead of only ever knowing about tasks it has
 * already attempted (the old single-step version only ever wrote the one
 * task it was about to run).
 */
async function initAllTasks(store: HarnessStore, goal: string, roles: string[]): Promise<void> {
  const existing = await store.loadTasksMarkdown();
  if (existing) return; // resume path — tasks.md already seeded by the original deploy
  const tasks: TaskItem[] = roles.map(role => ({ id: role, task: goal, status: 'pending', log: [] }));
  await saveTasks(store, goal, tasks);
}

async function beginTaskAttempt(store: HarnessStore, goal: string, role: string, note: string): Promise<void> {
  const tasks = await loadOrInitTasks(store, goal, role);
  let task = tasks.find(t => t.id === role);
  if (!task) {
    task = { id: role, task: goal, status: 'pending', log: [] };
    tasks.push(task);
  }
  task.status = 'in_progress';
  (task.log ??= []).push(`${new Date().toISOString()} ${note}`);
  await saveTasks(store, goal, tasks);
}

async function endTaskAttempt(store: HarnessStore, goal: string, role: string, outcome: TaskItem['status'], note: string): Promise<void> {
  const tasks = await loadOrInitTasks(store, goal, role);
  const task = tasks.find(t => t.id === role);
  if (task) {
    task.status = outcome;
    (task.log ??= []).push(`${new Date().toISOString()} ${note}`);
  }
  await saveTasks(store, goal, tasks);
}

/** A failure/pause is always retryable (task stays 'pending', matching coding_agents' "failed resume leaves the task pending" rule) — only a genuine success marks 'completed'. */
function taskOutcomeFor(status: HarnessRun['status']): TaskItem['status'] {
  return status === 'complete' ? 'completed' : status === 'failed' ? 'failed' : 'pending';
}

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
  const argsHashForTrace = hashArgs(args);
  await store.appendTrace({ runId: run.runId, role, type: 'tool_call', data: { tool, action, callId, argsHash: argsHashForTrace } });

  if (run.budget.used + run.budget.reserved + estimatedTokens > run.budget.maxTokens) {
    await store.appendTrace({ runId: run.runId, role, type: 'budget', data: { reason: 'would exceed maxTokens', estimatedTokens, remaining: run.budget.maxTokens - run.budget.used - run.budget.reserved } });
    return { ok: false, reason: 'budget', detail: 'Token budget would be exceeded by this call' };
  }
  if (run.budget.toolCalls + 1 > decl.harness.budget.maxToolCalls) {
    await store.appendTrace({ runId: run.runId, role, type: 'budget', data: { reason: 'max tool calls reached' } });
    return { ok: false, reason: 'budget', detail: 'Max tool call count reached for this run' };
  }

  const argsHash = argsHashForTrace;
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
    await store.appendTrace({ runId: run.runId, role, type: 'tool_result', data: { tool, callId, ok: true, argsHash } });
    return { ok: true, result };
  } catch (err: any) {
    // A thrown tool call previously left NO tool_result trace at all — the
    // audit log looked identical to a call that was never attempted.
    await store.appendTrace({ runId: run.runId, role, type: 'tool_result', data: { tool, callId, ok: false, argsHash, error: err?.message || String(err) } }).catch(() => {});
    throw err;
  } finally {
    run.budget.reserved -= estimatedTokens;
  }
}

/**
 * Which roles run, in order, for this run's lane. P4a's minimal step engine:
 * the goal-selected role always runs first; if the declaration also defines
 * an 'analyst' role (and it isn't already the selected one), it runs second
 * to synthesize the first step's findings — the smallest real multi-step
 * chain, not the full P4b–P4f research-depth ladder (browser/pdf/eisenhower/
 * brain), which stay separate phases. A declaration with only one non-
 * top_level role (every existing test declaration, and any harness that
 * simply doesn't define 'analyst') still runs exactly one step, unchanged
 * from before this change.
 */
function planSteps(decl: HarnessDeclaration, goal: string): string[] {
  const primary = selectRole(decl, goal);
  const roles = [primary];
  if (decl.roles.analyst && primary !== 'analyst') roles.push('analyst');
  return roles;
}

/** First step gets the raw goal; a later step gets a synthesis prompt built from the prior step's real (validated) handoff — never the raw prior goal again. */
function stepInputText(index: number, originalGoal: string, priorHandoff: Handoff | undefined): string {
  if (index === 0 || !priorHandoff) return originalGoal;
  const findingsText = priorHandoff.findings.length > 0
    ? priorHandoff.findings.map(f => `- ${f.claim} (source: ${f.source})`).join('\n')
    : '(no findings from the prior step)';
  return `Synthesize and critique the following research findings for the goal "${originalGoal}". Note limitations, open questions, and give a concise, grounded conclusion.\n\nFindings:\n${findingsText}`;
}

/**
 * Resolves a step's tool + payload WITHOUT executing or gating it — split
 * out from the old runRoleStep so the step engine can hash the payload
 * (repeat detection, D7 in the P4 plan) before deciding whether to call
 * gatedCall at all. Dispatches by the role's DECLARED tool instead of always
 * calling use_free_llm — a role declaring `load_skill_prompt` or
 * `execute_skill` as its allowlisted tool previously still only ever got
 * use_free_llm called, regardless of what the YAML said.
 */
function resolveStepDispatch(
  decl: HarnessDeclaration,
  role: string,
  stepGoal: string,
  workspaceRoot: string | undefined,
  registryKey: string
): { toolName: string; payload: any; execute: () => Promise<any> } {
  const toolName = decl.roles[role]?.tools?.[0]?.tool || 'use_free_llm';

  // This exact object is both hashed for approval-binding and passed to the
  // tool — one source of truth, so what a human approves is what runs.
  const useFreeLlmPayload = {
    messages: [
      { role: 'system', content: 'You are a research agent. Answer with grounded findings only; cite sources inline. Do not fabricate citations.' },
      { role: 'user', content: stepGoal },
    ],
    agentic: false,
    workspace_root: workspaceRoot,
    sessionId: registryKey,
    isOnePass: true,
  };
  const loadSkillPromptPayload = {
    type: 'search',
    keywords: stepGoal.split(/\s+/).filter(Boolean).slice(0, 8),
    workspaceDir: workspaceRoot,
    sessionId: registryKey,
  };
  // skillTags rides in the same payload that's both hashed and dispatched, so
  // a YAML rule like {tool:'execute_skill', constraints:{skillTags:['cyber']}}
  // (policy.ts's array-membership constraintsMatch) can actually gate this
  // call by tag instead of only by tool name.
  const executeSkillPayload = {
    skill: 'general-purpose',
    input: stepGoal,
    workspace_root: workspaceRoot,
    sessionId: registryKey,
    skillTags: CYBER_TERMS_REGEX.test(stepGoal) ? ['cyber'] : [],
  };

  const dispatchMap: Record<string, { payload: any; execute: () => Promise<any> }> = {
    use_free_llm: {
      payload: useFreeLlmPayload,
      execute: async () => (await import('../tools/use-free-llm.js')).useFreeLLM(useFreeLlmPayload as any),
    },
    load_skill_prompt: {
      payload: loadSkillPromptPayload,
      execute: async () => (await import('../tools/load-skill-prompt.js')).loadSkillPrompt(loadSkillPromptPayload as any),
    },
    execute_skill: {
      payload: executeSkillPayload,
      execute: async () => (await import('../tools/execute-skill.js')).executeSkill(executeSkillPayload as any),
    },
  };

  const resolved = dispatchMap[toolName] || dispatchMap.use_free_llm;
  const resolvedToolName = dispatchMap[toolName] ? toolName : 'use_free_llm';
  return { toolName: resolvedToolName, payload: resolved.payload, execute: resolved.execute };
}

/**
 * Repeat/loop guard (D7 in the P4 plan): true if this exact (callId,
 * argsHash) already reached a successful tool_result in this run's trace.
 * Only fires on a genuine re-attempt of an already-COMPLETED call, not on an
 * ordinary resume-after-approval replay — a paused call has a `tool_call`/
 * `policy_decision` trace but no `ok:true` `tool_result` yet, so resuming it
 * is never mistaken for a loop. Exported for direct unit testing since
 * P4a's linear (non-branching) step plan can't yet construct a real loop to
 * exercise this through the full deploy/resume flow — dynamic routing
 * (P4d's `delegate` paths and beyond) is what will actually call this on a
 * genuinely repeated call.
 */
export async function hasRepeatedSuccess(store: HarnessStore, callId: string, argsHash: string): Promise<boolean> {
  const events = await store.readTrace();
  return events.some(e =>
    e.type === 'tool_result' &&
    (e.data as any)?.callId === callId &&
    (e.data as any)?.argsHash === argsHash &&
    (e.data as any)?.ok === true
  );
}

/** Last successfully validated handoff in this run's trace, if any — used to rebuild a resumed step's input from persisted state, not from memory. */
async function lastHandoff(store: HarnessStore): Promise<Handoff | undefined> {
  const events = await store.readTrace();
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'handoff') {
      const validated = validateHandoff(events[i].data);
      if (validated.ok) return validated.handoff;
    }
  }
  return undefined;
}

interface StepEngineResult { content: string | undefined; lastRole: string }

/**
 * Runs steps[startIndex..] in order, stopping immediately (without
 * advancing) on the first step that doesn't finish 'complete' — a
 * needs_approval/budget pause or a genuine failure leaves every later step
 * untouched (and its task 'pending'), so resume continues from exactly this
 * point. Each successful step (except a final one) produces a real,
 * schema-validated Handoff that becomes the next step's input; a handoff
 * that fails validation stops the run rather than being silently accepted.
 */
async function runSteps(
  store: HarnessStore,
  run: HarnessRun,
  decl: HarnessDeclaration,
  roles: string[],
  startIndex: number,
  originalGoal: string,
  workspaceRoot: string | undefined,
  registryKey: string,
  aborted: boolean,
  priorHandoff: Handoff | undefined
): Promise<StepEngineResult> {
  let handoff = priorHandoff;
  let lastContent: string | undefined;
  let lastRole = roles[Math.min(startIndex, roles.length - 1)] ?? roles[0];

  for (let i = startIndex; i < roles.length; i++) {
    const role = roles[i];
    lastRole = role;
    const callId = `s${i}:${role}`;
    const stepGoal = stepInputText(i, originalGoal, handoff);
    const dispatch = resolveStepDispatch(decl, role, stepGoal, workspaceRoot, registryKey);
    const argsHash = hashArgs(dispatch.payload);

    if (await hasRepeatedSuccess(store, callId, argsHash)) {
      run.status = 'failed';
      run.error = `Repeat detected: step '${callId}' already completed with identical arguments (needs_user)`;
      await store.appendTrace({ runId: run.runId, role, type: 'error', data: { message: run.error } }).catch(() => {});
      await endTaskAttempt(store, originalGoal, role, 'failed', `repeat detected: ${run.error}`);
      return { content: lastContent, lastRole };
    }

    await beginTaskAttempt(store, originalGoal, role, `step ${callId}: attempting via ${dispatch.toolName}`);
    const goalTokens = contextManager.countStringTokens(stepGoal);
    const estimate = goalTokens + 2000;
    const callResult = await gatedCall(store, run, decl, role, dispatch.toolName, undefined, dispatch.payload, estimate, callId, dispatch.execute);
    const { content } = applyResearchResult(run, role, callResult, goalTokens, aborted);
    await endTaskAttempt(store, originalGoal, role, taskOutcomeFor(run.status), `step ${callId}: ${run.status}${run.error ? ` (${run.error})` : ''}`);

    if (run.status !== 'complete') {
      // paused_approval / paused_budget / failed / aborted — later steps stay
      // untouched (still 'pending' in tasks.md) so resume picks up here.
      return { content: lastContent ?? content, lastRole };
    }

    lastContent = content;
    const isLastStep = i === roles.length - 1;
    const nextTo = isLastStep ? 'top_level' : roles[i + 1];
    const built = buildHandoff(role, nextTo, content ?? '');
    const validated = validateHandoff(built);
    if (!validated.ok) {
      run.status = 'failed';
      run.error = `Malformed handoff from step '${callId}': ${validated.error}`;
      await store.appendTrace({ runId: run.runId, role, type: 'error', data: { message: run.error } }).catch(() => {});
      await endTaskAttempt(store, originalGoal, role, 'failed', run.error);
      return { content: lastContent, lastRole };
    }
    await store.appendTrace({ runId: run.runId, role, type: 'handoff', data: validated.handoff }).catch(() => {});
    handoff = validated.handoff;

    if (!isLastStep) run.status = 'running'; // more steps to go — applyResearchResult marked this one 'complete', but the RUN isn't done yet
  }

  return { content: lastContent, lastRole };
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
  // Different dispatched tools return content under different keys
  // (use_free_llm: choices[0].message.content, execute_skill: response,
  // load_skill_prompt: prompt) — checking only the use_free_llm shape made
  // every non-use_free_llm success look like an empty result.
  const content: string =
    callResult.result?.choices?.[0]?.message?.content ??
    callResult.result?.response ??
    callResult.result?.prompt ??
    '';
  run.budget.used += contextManager.countStringTokens(content) + goalTokens;
  run.result = content;
  if (!content) {
    run.status = 'failed';
    run.error = 'Role step completed without error but produced no content.';
    return {};
  }
  run.status = 'complete';
  return { content };
}

/**
 * No longer synthesizes a handoff here — runSteps already appended a real,
 * schema-validated one (or more, chained) per step as it ran. The old
 * version fabricated exactly one handoff at the very end with a hardcoded
 * `confidence: 0.7` and `source: 'use_free_llm'` regardless of which tool
 * actually ran — "the handoff is logging, not communication" per the P4
 * plan's own self-review. Just finalizes run state and the registry now.
 */
async function finalizeRun(store: HarnessStore, run: HarnessRun, registryKey: string): Promise<void> {
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
 * Deploys (starts) a background harness run: plans a lane of steps
 * (planSteps — the goal-selected role, plus 'analyst' if the declaration
 * defines one), then runs them via the step engine (runSteps), producing a
 * real validated Handoff per step instead of one synthetic one at the end
 * (see docs/plans/2026-09-29-harness-p4-subagents-brain.md, P4a).
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

  const decl = await loadHarnessDeclaration(input.harness, input.workspaceRoot);
  assertWorkspaceRootAllowed(decl, input.workspaceRoot);
  const roles = planSteps(decl, input.goal);
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
  await store.appendTrace({ runId: run.runId, role: 'top_level', type: 'run_start', data: { goal: input.goal, roles } });
  await initAllTasks(store, input.goal, roles);

  const runInfo = RunRegistry.start(registryKey);

  (async () => {
    try {
      const { content } = await runSteps(store, run, decl, roles, 0, input.goal, input.workspaceRoot, registryKey, runInfo.controller.signal.aborted, undefined);
      await finalizeRun(store, run, registryKey);
      void content; // final content already persisted onto run.result inside runSteps/applyResearchResult
    } catch (err: any) {
      run.status = 'failed';
      run.error = err?.message || String(err);
      await store.appendTrace({ runId: run.runId, role: 'top_level', type: 'error', data: { message: run.error } }).catch(() => {});
      await finalizeRun(store, run, registryKey);
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

  const decl = await loadHarnessDeclaration(run.declarationName, run.workspaceRoot);
  // Re-validated on resume too — a declaration edited between deploy and
  // resume (e.g. allowedWorkspaceRoots tightened) must not grandfather in a
  // workspace_root that would no longer be permitted.
  assertWorkspaceRootAllowed(decl, run.workspaceRoot);
  const roles = planSteps(decl, run.goal);
  const registryKey = `harness:${runId}`;

  // tasks.md IS the cursor: the first task not yet 'completed', in step
  // order, is where this run left off. Rebuilt from persisted state on every
  // resume, never kept in memory — matches how coding_agents' own blackboard
  // resume works.
  const tasksRaw = await store.loadTasksMarkdown();
  const tasks = tasksRaw ? parseTasksMarkdown(tasksRaw) : [];
  let startIndex = roles.findIndex(r => tasks.find(t => t.id === r)?.status !== 'completed');
  if (startIndex === -1) startIndex = Math.max(0, roles.length - 1); // everything already completed — re-attempt the last step defensively rather than no-op

  const priorHandoff = await lastHandoff(store);

  run.status = 'running';
  run.error = undefined;
  await store.saveRun(run);

  const runInfo = RunRegistry.start(registryKey);

  (async () => {
    try {
      const { content } = await runSteps(store, run, decl, roles, startIndex, run.goal, run.workspaceRoot, registryKey, runInfo.controller.signal.aborted, priorHandoff);
      await finalizeRun(store, run, registryKey);
      void content;
    } catch (err: any) {
      run.status = 'failed';
      run.error = err?.message || String(err);
      await store.appendTrace({ runId: run.runId, role: 'top_level', type: 'error', data: { message: run.error } }).catch(() => {});
      await finalizeRun(store, run, registryKey);
    }
  })().catch(() => {});

  return run;
}

export function abortHarness(runId: string): boolean {
  return RunRegistry.abort(`harness:${runId}`);
}
