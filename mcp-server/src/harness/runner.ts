import { RunRegistry } from '../pipeline/middlewares/RunRegistry.js';
import { ContextManager } from '../utils/ContextManager.js';
import { HarnessStore } from './store.js';
import { loadHarnessDeclaration, selectRole } from './declaration.js';
import { trackDeclaration, verifyDeclarationIntegrity, type RegistryEntry } from './registry.js';
import { evaluate, hashArgs, assertWorkspaceRootAllowed, laneCycleMax, canStartLaneCycle, stripCycleSuffix } from './policy.js';
import { serializeTasksMarkdown, parseTasksMarkdown, type TaskItem } from '../tools/coding-agents.js';
import { CYBER_TERMS_REGEX } from '../utils/TaskClassifier.js';
import { buildHandoff, validateHandoff, type Handoff } from './handoff.js';
import { createReasoningStrategy, type LessonNode, type StepFailure } from './reasoning.js';
import { MonitorRegistry } from './monitor.js';
import { appendSessionMemory, buildSessionMemoryPromptBlock, parseTurnMemory, recentSessionMemory } from './session-memory.js';
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

export type GatedDetachResult =
  | { ok: true; monitorId: string }
  | { ok: false; reason: 'needs_approval' | 'budget' | 'denied'; detail: string };

/**
 * P5 (docs/plans/2026-09-29-harness-p5-monitor-tool.md, D1) — sibling to
 * gatedCall, not a replacement: same budget-reserve + policy.evaluate gate
 * (a detached process still needs an allow/approval decision before it
 * starts, no exception), but instead of awaiting one round trip, calls
 * `start()` which returns immediately with a handle, registers it in
 * MonitorRegistry, and returns. Budget for the detached work itself settles
 * incrementally via MonitorRegistry.reportProgress callers (D3), not here —
 * nothing is spent yet besides the attach call's own estimate.
 */
export async function gatedDetach(
  store: HarnessStore,
  run: HarnessRun,
  decl: HarnessDeclaration,
  role: string,
  tool: string,
  action: string | undefined,
  args: any,
  estimatedTokens: number,
  callId: string,
  start: () => Promise<{ handle: string }>
): Promise<GatedDetachResult> {
  const argsHash = hashArgs(args);
  await store.appendTrace({ runId: run.runId, role, type: 'tool_call', data: { tool, action, callId, argsHash, detached: true } });

  if (run.budget.used + run.budget.reserved + estimatedTokens > run.budget.maxTokens) {
    await store.appendTrace({ runId: run.runId, role, type: 'budget', data: { reason: 'would exceed maxTokens', estimatedTokens, remaining: run.budget.maxTokens - run.budget.used - run.budget.reserved } });
    return { ok: false, reason: 'budget', detail: 'Token budget would be exceeded by this call' };
  }
  if (run.budget.toolCalls + 1 > decl.harness.budget.maxToolCalls) {
    await store.appendTrace({ runId: run.runId, role, type: 'budget', data: { reason: 'max tool calls reached' } });
    return { ok: false, reason: 'budget', detail: 'Max tool call count reached for this run' };
  }

  const decision = evaluate(decl, role, tool, action, args);
  await store.appendTrace({ runId: run.runId, role, type: 'policy_decision', data: { tool, action, callId, decision: decision.kind } });

  if (decision.kind === 'deny') {
    return { ok: false, reason: 'denied', detail: decision.reason };
  }
  if (decision.kind === 'needs_approval') {
    await store.expireStale(decl.harness.approval.timeoutMinutes);
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

  run.budget.toolCalls += 1; // the attach itself counts as one call; the detached work's token cost settles incrementally, not here
  const { handle } = await start();
  MonitorRegistry.attach(callId, run.runId, role, tool, handle, run.workspaceRoot);
  await store.appendTrace({ runId: run.runId, role, type: 'monitor_attached', data: { monitorId: callId, handle } }).catch(() => {});
  return { ok: true, monitorId: callId };
}

/**
 * Which roles run, in order, for this run's lane.
 *
 * T5 — a declaration with an explicit `harness.lane` walks the phase list
 * for every allowed cycle (cycle 1 = plain phase ids, cycles ≥2 = `phase#cN`),
 * capped by laneCycleMax: the lane IS the exact plan, so selectRole and the
 * analyst append below are bypassed entirely (goal-based role selection and
 * the legacy two-step chain don't apply to an owner-declared lane). Each
 * `#cN` id makes that cycle a separate tasks.md entry (own attempts, own
 * resume cursor) while runSteps strips the suffix back to the base role for
 * policy/handoff/traces.
 *
 * Legacy (no lane) path — P4a's minimal step engine, unchanged: the
 * goal-selected role always runs first; if the declaration also defines an
 * 'analyst' role (and it isn't already the selected one), it runs second to
 * synthesize the first step's findings. A declaration with only one non-
 * top_level role still runs exactly one step.
 */
function planSteps(decl: HarnessDeclaration, goal: string): string[] {
  const lane = decl.harness.lane;
  if (lane && lane.length > 0) {
    const maxCycles = laneCycleMax(decl) ?? 1;
    const plan: string[] = [];
    for (let cycle = 1; cycle <= maxCycles; cycle++) {
      for (const phase of lane) plan.push(cycle === 1 ? phase : `${phase}#c${cycle}`);
    }
    return plan;
  }
  const primary = selectRole(decl, goal);
  const roles = [primary];
  if (decl.roles.analyst && primary !== 'analyst') roles.push('analyst');
  return roles;
}

/**
 * On resume, the step list must come from tasks.md (the persisted record of
 * what this run actually planned, including any dynamically-inserted 'html'
 * escalation step below — see decideEscalation) rather than recomputing
 * planSteps() fresh, which only knows the STATIC base plan and would drop a
 * step that got spliced in live during the original run.
 */
async function loadStepRoles(store: HarnessStore, decl: HarnessDeclaration, goal: string): Promise<string[]> {
  const raw = await store.loadTasksMarkdown();
  if (raw) {
    const tasks = parseTasksMarkdown(raw);
    if (tasks.length > 0) return tasks.map(t => t.id);
  }
  return planSteps(decl, goal);
}

/**
 * P4b research depth ladder (deterministic, never an LLM choice, per D6 in
 * the P4 plan) — abstract → html only in this slice. Escalates past a
 * researcher step's abstract-level answer to a real page fetch when
 * confidence is low AND the declaration defines a 'scraper' role AND a
 * fetchable URL is actually present in the findings — otherwise there's
 * nothing to escalate TO, so it's skipped rather than failing the run.
 * pdf escalation (contentDepth 'pdf', resolvePdfRef) is explicitly NOT part
 * of this slice — deferred, same as this session's other disclosed partial-
 * scope commits, rather than rushing a third branch untested.
 */
/**
 * pdf checked BEFORE html: a `.pdf`/`pdf://` source shouldn't be web-scraped
 * via browser_tool — resolvePdfRef reads it directly and is the more
 * accurate depth level for that source type, matching the plan's
 * abstract->html->pdf ladder ordering (contentDepth.order). Deviates from
 * D6's own sketch (`pdf_read` as one of researcher's OWN tools) — kept as
 * its own pseudo-role ('pdf'), same precedent as 'scraper' for html, so the
 * existing task-id-is-the-role-name invariant (P4a) holds without a role
 * ever running twice in one lane.
 */
function decideEscalation(decl: HarnessDeclaration, role: string, handoff: Handoff): string | null {
  if (role !== 'researcher') return null; // only escalate off the abstract-level pass, not off analyst/scraper/pdf output
  if (handoff.status !== 'complete') return null;
  const threshold = decl.handoff?.lowConfidenceThreshold ?? 0.7;
  if (handoff.confidence >= threshold) return null;

  if (decl.roles.pdf && extractFirstPdfRef(handoff)) return 'pdf';
  if (decl.roles.scraper && extractFirstUrl(handoff)) return 'scraper';
  return null;
}

function extractFirstUrl(handoff: Handoff): string | null {
  const text = handoff.findings.map(f => f.claim).join(' ');
  const match = text.match(/https?:\/\/[^\s)\]"'>]+/);
  return match ? match[0] : null;
}

/** Matches `pdf://<path>[:page]` first (the researcher role's own trigger convention), else a bare `<path>.pdf[:page]`. */
function extractFirstPdfRef(handoff: Handoff): string | null {
  const text = handoff.findings.map(f => f.claim).join(' ');
  const schemed = text.match(/pdf:\/\/([^\s)\]"'>]+)/);
  if (schemed) return schemed[1];
  const bare = text.match(/[^\s)\]"'>]+\.pdf(?::\d+)?/i);
  return bare ? bare[0] : null;
}

/** First step gets the raw goal (plus recalled memory context, if any); a later step gets a synthesis prompt built from the prior step's real (validated) handoff — never the raw prior goal again. */
function stepInputText(index: number, originalGoal: string, priorHandoff: Handoff | undefined, memoryContext?: string): string {
  if (index === 0 || !priorHandoff) return memoryContext ? `${memoryContext}\n\n${originalGoal}` : originalGoal;
  const findingsText = priorHandoff.findings.length > 0
    ? priorHandoff.findings.map(f => `- ${f.claim} (source: ${f.source})`).join('\n')
    : '(no findings from the prior step)';
  return `Synthesize and critique the following research findings for the goal "${originalGoal}". Note limitations, open questions, and give a concise, grounded conclusion.\n\nFindings:\n${findingsText}`;
}

/**
 * P4c recall ("step 0" in the plan's table): best-effort graph_query against
 * decayed memory, scored by recency-adjusted retention x simple keyword
 * relevance, injected as a memory context block ahead of the goal. Never
 * blocks or pauses the run for it — pre-checks policy.evaluate() directly
 * (not gatedCall) so an ungranted allowlist just means "no memory context"
 * rather than parking the whole run on an approval for an optional
 * enrichment step. Only ever called when starting from step 0 (a genuinely
 * fresh run, not a resume from a later step).
 */
async function recallMemoryContext(
  store: HarnessStore,
  run: HarnessRun,
  decl: HarnessDeclaration,
  goal: string,
  workspaceRoot: string | undefined,
  registryKey: string
): Promise<{ context: string; recalledNodes: { id: string; content: string }[] } | undefined> {
  const payload = { action: 'graph_query', workspace_root: workspaceRoot };
  if (evaluate(decl, 'top_level', 'manage_memory', 'graph_query', payload).kind !== 'allow') return undefined;

  try {
    const result = await gatedCall(
      store, run, decl, 'top_level', 'manage_memory', 'graph_query', payload, 300, 's-1:recall',
      async () => (await import('../tools/manage-memory.js')).manageMemory(payload as any)
    );
    if (!result.ok) return undefined;
    trackTopLevelTokens(run, 300);
    const nodes: any[] = result.result?.nodes ?? [];
    if (nodes.length === 0) return undefined;

    const { retentionOf } = await import('../memory/retention.js');
    const goalTerms = goal.toLowerCase().split(/\s+/).filter(t => t.length > 3);

    const scored = nodes
      .map(n => {
        const content = String(n.content ?? '');
        const relevance = goalTerms.filter(t => content.toLowerCase().includes(t)).length;
        const retention = retentionOf({
          confidence: n.confidence ?? 0.5,
          lastReviewedAt: n.lastReviewedAt ?? Date.now(),
          halfLifeDays: n.halfLifeDays ?? 30,
        });
        return { node: n, score: relevance * (0.5 + retention) };
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    if (scored.length === 0) return undefined;

    return {
      context: `## Known context from memory\n${scored.map(s => `- ${String(s.node.content).slice(0, 300)}`).join('\n')}`,
      recalledNodes: scored.filter(s => s.node.id).map(s => ({ id: s.node.id, content: String(s.node.content ?? '') })),
    };
  } catch {
    return undefined; // best-effort — a memory-layer error must never fail the run
  }
}

/**
 * P4c write-back ("step 6"): persists the run's final content to the DAG
 * and wiki, and reinforces (node_review) any recalled node whose content
 * substring shows up verbatim in the final result — a crude but real
 * "was this actually used" signal, not a blanket review of everything
 * recalled. Same best-effort posture as recall: each call is pre-checked
 * against policy.evaluate() and skipped (not failed) if not allowed; the
 * run's own result/handoffs are already correct without this, so a memory
 * write failing must never flip a 'complete' run to 'failed'.
 */
async function writeBackToMemory(
  store: HarnessStore,
  run: HarnessRun,
  decl: HarnessDeclaration,
  goal: string,
  content: string,
  recalledNodes: { id: string; content: string }[],
  workspaceRoot: string | undefined
): Promise<void> {
  const goalSlug = goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60).replace(/^-+|-+$/g, '') || 'run';

  const nodePayload = { action: 'node_add', workspace_root: workspaceRoot, node: { type: 'text' as const, content: content.slice(0, 2000), tags: [goalSlug] } };
  if (evaluate(decl, 'top_level', 'manage_memory', 'node_add', nodePayload).kind === 'allow') {
    const r = await gatedCall(store, run, decl, 'top_level', 'manage_memory', 'node_add', nodePayload, 300, 's-2:writeback:node', async () =>
      (await import('../tools/manage-memory.js')).manageMemory(nodePayload as any)
    ).catch(() => ({ ok: false } as GatedResult));
    if (r.ok) trackTopLevelTokens(run, 300);
  }

  const wikiPayload = { action: 'wiki_write', workspace_root: workspaceRoot, title: `Harness run: ${goalSlug}`, content, tags: [goalSlug] };
  if (evaluate(decl, 'top_level', 'manage_memory', 'wiki_write', wikiPayload).kind === 'allow') {
    await gatedCall(store, run, decl, 'top_level', 'manage_memory', 'wiki_write', wikiPayload, 300, 's-2:writeback:wiki', async () =>
      (await import('../tools/manage-memory.js')).manageMemory(wikiPayload as any)
    ).catch(() => {});
  }

  // Reinforce only nodes actually reflected in the final result (a real,
  // if crude, "was this cited" check — a snippet of the recalled content
  // showing up verbatim in the synthesis) — not a blanket review of
  // everything recall happened to surface.
  for (const node of recalledNodes) {
    const snippet = node.content.slice(0, 60).trim();
    if (!snippet || !content.includes(snippet)) continue;
    const reviewPayload = { action: 'node_review', workspace_root: workspaceRoot, nodeId: node.id };
    if (evaluate(decl, 'top_level', 'manage_memory', 'node_review', reviewPayload).kind === 'allow') {
      await gatedCall(store, run, decl, 'top_level', 'manage_memory', 'node_review', reviewPayload, 100, `s-2:writeback:review:${node.id}`, async () =>
        (await import('../tools/manage-memory.js')).manageMemory(reviewPayload as any)
      ).catch(() => {});
    }
  }
}

/**
 * P4d Eisenhower review — SUBMIT half only (D4 in the P4 plan). Every real
 * open question the final step actually phrased (handoff.openQuestions,
 * extracted in handoff.ts) becomes an eisenhower_add task with deterministic
 * flags, never an LLM guess (autoClassify stays off, per standing
 * instruction):
 *   - urgent: this run's own final step didn't cleanly finish (status
 *     'blocked'/'needs_user', or it explicitly needs approval) — the
 *     question is blocking something concrete in THIS run.
 *   - important: the question shares a real keyword with an actual finding
 *     (a core claim), not a tangent.
 * NOT implemented here — deferred, same disclosed-partial-scope pattern as
 * P4b's pdf branch: reading the backlog back (`eisenhower_list`) and acting
 * per quadrant (do/schedule/delegate/delete), especially `delegate` →
 * spawning a scoped sub-run. That's a real recursive-deploy capability, the
 * same size class as the fan-out/park-revive gaps docs/harness-cyber.md
 * already flagged as separate P5+ work — not something to bolt on here.
 */
async function submitOpenQuestions(
  store: HarnessStore,
  run: HarnessRun,
  decl: HarnessDeclaration,
  goal: string,
  handoff: Handoff,
  workspaceRoot: string | undefined
): Promise<void> {
  if (handoff.openQuestions.length === 0) return;
  const goalSlug = goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60).replace(/^-+|-+$/g, '') || 'run';
  const urgent = handoff.status === 'blocked' || handoff.status === 'needs_user' || handoff.requiresApproval.needed;
  const findingsText = handoff.findings.map(f => f.claim).join(' ').toLowerCase();

  for (const question of handoff.openQuestions) {
    const questionTerms = question.toLowerCase().split(/\s+/).filter(t => t.length > 4);
    const important = questionTerms.some(t => findingsText.includes(t));
    const payload = { action: 'eisenhower_add', workspace_root: workspaceRoot, task: question, urgent, important, tags: [goalSlug] };
    if (evaluate(decl, 'top_level', 'manage_memory', 'eisenhower_add', payload).kind === 'allow') {
      await gatedCall(store, run, decl, 'top_level', 'manage_memory', 'eisenhower_add', payload, 100, `s-3:eisenhower:${goalSlug}:${handoff.openQuestions.indexOf(question)}`, async () =>
        (await import('../tools/manage-memory.js')).manageMemory(payload as any)
      ).catch(() => {});
    }
  }
}

/**
 * P4e trial-and-error (D5) — recalls past lesson nodes for this exact
 * role+tool pairing (tagged 'lesson', filtered client-side since DagMemory's
 * graph_query has no server-side tag filter), scored by retention.ts. Same
 * best-effort posture as recall/write-back: an ungranted allowlist or a
 * memory error just means "no lessons available", not a failure.
 */
async function recallLessons(
  store: HarnessStore,
  run: HarnessRun,
  decl: HarnessDeclaration,
  role: string,
  tool: string,
  workspaceRoot: string | undefined
): Promise<LessonNode[]> {
  const payload = { action: 'graph_query', workspace_root: workspaceRoot };
  if (evaluate(decl, 'top_level', 'manage_memory', 'graph_query', payload).kind !== 'allow') return [];
  try {
    const result = await gatedCall(store, run, decl, 'top_level', 'manage_memory', 'graph_query', payload, 200, `lessons:${role}:${tool}`, async () =>
      (await import('../tools/manage-memory.js')).manageMemory(payload as any)
    );
    if (!result.ok) return [];
    const nodes: any[] = result.result?.nodes ?? [];
    const { retentionOf } = await import('../memory/retention.js');
    return nodes
      .filter(n => Array.isArray(n.tags) && n.tags.includes('lesson') && n.tags.includes(role) && n.tags.includes(tool))
      .map(n => {
        let parsed: { failureKind?: string; strategy?: string } = {};
        try { parsed = JSON.parse(n.content); } catch { /* malformed lesson content — treat as generic */ }
        return {
          id: n.id,
          role,
          tool,
          failureKind: (parsed.failureKind as LessonNode['failureKind']) ?? 'tool_error',
          strategy: parsed.strategy ?? 'retry-same',
          retention: retentionOf({ confidence: n.confidence ?? 0.5, lastReviewedAt: n.lastReviewedAt ?? Date.now(), halfLifeDays: n.halfLifeDays ?? 7 }),
        };
      });
  } catch {
    return [];
  }
}

/** Short half-life (7 days, per D5) so a stale lesson fades and stops influencing strategy choice. */
async function writeLessonNode(
  store: HarnessStore,
  run: HarnessRun,
  decl: HarnessDeclaration,
  role: string,
  tool: string,
  failureKind: StepFailure['failureKind'],
  strategy: string,
  workspaceRoot: string | undefined
): Promise<void> {
  const payload = {
    action: 'node_add', workspace_root: workspaceRoot,
    node: { type: 'text' as const, content: JSON.stringify({ role, tool, failureKind, strategy }), tags: ['lesson', role, tool], halfLifeDays: 7, confidence: 0.5 },
  };
  if (evaluate(decl, 'top_level', 'manage_memory', 'node_add', payload).kind !== 'allow') return;
  await gatedCall(store, run, decl, 'top_level', 'manage_memory', 'node_add', payload, 200, `lesson-write:${role}:${tool}:${Date.now()}`, async () =>
    (await import('../tools/manage-memory.js')).manageMemory(payload as any)
  ).catch(() => {});
}

/** A lesson that was reused and then led to a successful retry gets reinforced (D5: "successful strategy after a failure -> node_review, preferred next time"). */
async function reinforceLesson(store: HarnessStore, run: HarnessRun, decl: HarnessDeclaration, lessonId: string, workspaceRoot: string | undefined): Promise<void> {
  const payload = { action: 'node_review', workspace_root: workspaceRoot, nodeId: lessonId };
  if (evaluate(decl, 'top_level', 'manage_memory', 'node_review', payload).kind !== 'allow') return;
  await gatedCall(store, run, decl, 'top_level', 'manage_memory', 'node_review', payload, 100, `lesson-reinforce:${lessonId}`, async () =>
    (await import('../tools/manage-memory.js')).manageMemory(payload as any)
  ).catch(() => {});
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
  registryKey: string,
  memoryBlock = ''
): { toolName: string; payload: any; execute: () => Promise<any> } {
  const toolName = decl.roles[role]?.tools?.[0]?.tool || 'use_free_llm';

  const normalizeTag = (t: string) => t.toLowerCase().replace(/[-_]+/g, ' ').trim();
  let matchedSkill: { name: string; dir?: string; tags: string[] } | undefined;
  const catalog = decl.skillCatalog;
  if (catalog && Object.keys(catalog).length > 0) {
    const goalNorm = normalizeTag(stepGoal);
    for (const rule of decl.roles[role]?.tools ?? []) {
      if (rule.tool !== 'execute_skill') continue;
      const ruleTags = (rule.constraints as { skillTags?: unknown } | undefined)?.skillTags;
      if (!Array.isArray(ruleTags)) continue;
      for (const [name, entry] of Object.entries(catalog)) {
        const entryTags = (entry.tags ?? []).filter(t => typeof t === 'string');
        const shared = entryTags.filter(t => ruleTags.some(rt => typeof rt === 'string' && normalizeTag(rt) === normalizeTag(t)));
        if (shared.length === 0) continue;
        if (shared.some(t => goalNorm.includes(normalizeTag(t)))) {
          matchedSkill = { name, dir: entry.dir, tags: entryTags };
          break;
        }
      }
      if (matchedSkill) break;
    }
  }

  // This exact object is both hashed for approval-binding and passed to the
  // tool — one source of truth, so what a human approves is what runs.
  const systemPrompt = 'You are a research agent. Answer with grounded findings only; cite sources inline. Do not fabricate citations.';
  const useFreeLlmPayload = {
    messages: [
      { role: 'system', content: memoryBlock ? `${systemPrompt}\n\n${memoryBlock}` : systemPrompt },
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
    skill: matchedSkill?.name ?? 'general-purpose',
    input: stepGoal,
    workspace_root: workspaceRoot,
    sessionId: registryKey,
    skillTags: matchedSkill
      ? [...new Set([...matchedSkill.tags, ...(CYBER_TERMS_REGEX.test(stepGoal) ? ['cyber'] : [])])]
      : CYBER_TERMS_REGEX.test(stepGoal) ? ['cyber'] : [],
    ...(matchedSkill?.dir ? { skillDir: matchedSkill.dir } : {}),
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
    coding_agents: {
      payload: useFreeLlmPayload,
      execute: async () => (await import('../tools/use-free-llm.js')).useFreeLLM(useFreeLlmPayload as any),
    },
  };

  const effectiveToolName = matchedSkill ? 'execute_skill' : toolName;
  const resolved = dispatchMap[effectiveToolName] || dispatchMap.use_free_llm;
  const resolvedToolName = dispatchMap[effectiveToolName] ? effectiveToolName : 'use_free_llm';
  return { toolName: resolvedToolName, payload: resolved.payload, execute: resolved.execute };
}

/**
 * Scraper (html-level) step for the research depth ladder: navigate then
 * extract, each its own separately policy-gated/traced/approvable call
 * (matching the bundled declaration's `actions: [navigate, extract, ...]`
 * per-action allowlist), not one opaque composite call. Returns the
 * extract call's GatedResult (navigate is plumbing — its content doesn't
 * feed the handoff); a navigate failure/pause short-circuits before ever
 * attempting extract.
 */
async function runScraperStep(
  store: HarnessStore,
  run: HarnessRun,
  decl: HarnessDeclaration,
  role: string,
  callId: string,
  url: string,
  registryKey: string
): Promise<GatedResult> {
  const { dispatchBrowserAction } = await import('../browser/dispatch.js');

  const navigatePayload = { action: 'navigate', url, sessionId: registryKey };
  const navigateResult = await gatedCall(
    store, run, decl, role, 'browser_tool', 'navigate', navigatePayload, 500, `${callId}:navigate`,
    async () => dispatchBrowserAction(navigatePayload)
  );
  if (!navigateResult.ok) return navigateResult;

  const extractPayload = { action: 'extract', sessionId: registryKey, params: { strategy: 'auto' } };
  return gatedCall(
    store, run, decl, role, 'browser_tool', 'extract', extractPayload, 1500, `${callId}:extract`,
    async () => dispatchBrowserAction(extractPayload)
  );
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

interface StepEngineResult { content: string | undefined; lastRole: string; finalHandoff: Handoff | undefined }

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
  priorHandoff: Handoff | undefined,
  memoryContext?: string
): Promise<StepEngineResult> {
  let handoff = priorHandoff;
  let lastContent: string | undefined;
  let lastRole = stripCycleSuffix(roles[Math.min(startIndex, roles.length - 1)] ?? roles[0]);

  // startIndex can equal roles.length when the caller (resumeMonitoredRun,
  // P5) just finished the LAST step in the lane out-of-band (a monitored
  // step resolving) and is calling this only to run the envelope tail —
  // there's nothing left to iterate, and that's success, not a stall. Without
  // this, the loop below simply never executes and run.status is left
  // exactly as the caller set it going in ('running'), never becoming
  // 'complete' — a real bug this test suite caught directly.
  if (startIndex >= roles.length) {
    run.status = 'complete';
    return { content: run.result, lastRole, finalHandoff: handoff };
  }

  for (let i = startIndex; i < roles.length; i++) {
    // T5 — two views of the plan entry: stepId is the FULL plan id (what
    // tasks.md holds, so each lane cycle is its own task/cursor position),
    // role is the BASE name (what policy, handoffs, traces, budget.perRole
    // and lessons are keyed by — cycle 2 of 'fixer' runs under the same
    // declaration entry as cycle 1). callId keeps the full id so the
    // repeat detector can't mistake a repeated cycle for a loop.
    const stepId = roles[i];
    const role = stripCycleSuffix(stepId);
    lastRole = role;
    const callId = `s${i}:${stepId}`;

    if (wallBudgetExceeded(run, decl)) {
      run.status = 'paused_budget';
      run.error = `Wall-clock budget exceeded (maxWallMinutes: ${decl.harness.budget.maxWallMinutes})`;
      await store.appendTrace({ runId: run.runId, role, type: 'budget', data: { reason: 'maxWallMinutes exceeded' } }).catch(() => {});
      return { content: lastContent, lastRole, finalHandoff: handoff };
    }

    // T5 — fail-closed cycle guard: a `#cN` step may only run while the
    // declaration's lane policy still allows cycle N (hand-edited tasks.md,
    // or a declaration whose maxCycles shrank between deploy and resume,
    // must not run an extra cycle). A legacy (no-lane) plan can never
    // legitimately contain a suffix, so canStartLaneCycle's null → false
    // makes any stray `#cN` on a legacy run fail closed too.
    const cycleMatch = stepId.match(/#c(\d+)$/);
    if (cycleMatch && !canStartLaneCycle(decl, Number(cycleMatch[1]))) {
      run.status = 'failed';
      run.error = `Lane cycle ${cycleMatch[1]} is not allowed (step '${stepId}')`;
      await store.appendTrace({ runId: run.runId, role, type: 'error', data: { message: run.error } }).catch(() => {});
      await endTaskAttempt(store, originalGoal, stepId, 'failed', run.error);
      return { content: lastContent, lastRole, finalHandoff: handoff };
    }

    // T5 — one `phase` trace per executed lane step, emitted BEFORE the step
    // runs (including a cyber_tool attach, so the monitored step's phase is
    // on record at attach time, not only at monitor resolution). Lane
    // declarations only: legacy runs keep their old trace stream unchanged.
    // `role`/`phase` stay the base name; `taskId` is the full plan id the
    // tasks cursor uses; `total` is the plan length at emission time.
    if (decl.harness.lane && decl.harness.lane.length > 0) {
      await store.appendTrace({
        runId: run.runId, role, type: 'phase',
        data: { phase: role, cycle: cycleMatch ? Number(cycleMatch[1]) : 1, taskId: stepId, index: i, total: roles.length },
      }).catch(() => {});
    }

    // P5b — a role whose declared tool is 'cyber_tool' attaches to a
    // detached osint scan (gatedDetach) instead of completing synchronously.
    // Fixes the real design gap found while scoping P5b: the step engine
    // had no way to represent "attached, still running" as a first-class
    // pause with its own resume semantics — see HarnessRun.pendingMonitor
    // and resumeMonitoredRun below for the other half of this.
    if (decl.roles[role]?.tools?.[0]?.tool === 'cyber_tool') {
      const target = stepInputText(i, originalGoal, handoff, i === startIndex ? memoryContext : undefined).trim();
      const detachPayload = { action: 'osint', target, autoSearch: true, sessionId: registryKey };
      const detachArgsHash = hashArgs(detachPayload);
      if (await hasRepeatedSuccess(store, callId, detachArgsHash)) {
        run.status = 'failed';
        run.error = `Repeat detected: step '${callId}' already completed with identical arguments (needs_user)`;
        await store.appendTrace({ runId: run.runId, role, type: 'error', data: { message: run.error } }).catch(() => {});
        await endTaskAttempt(store, originalGoal, stepId, 'failed', `repeat detected: ${run.error}`);
        return { content: lastContent, lastRole, finalHandoff: handoff };
      }
      await beginTaskAttempt(store, originalGoal, stepId, `step ${callId}: attaching cyber_tool osint scan on '${target}'`);
      const attach = await gatedDetach(store, run, decl, role, 'cyber_tool', 'osint', detachPayload, 500, callId, async () => {
        const { cyberTool } = await import('../tools/cyber-tool.js');
        await cyberTool(detachPayload as any); // returns almost immediately — the actual search runs detached inside cyber-tool.ts's own IIFE
        return { handle: `osint:${registryKey}:${target}` };
      });
      if (!attach.ok) {
        run.status = attach.reason === 'needs_approval' ? 'paused_approval' : 'paused_budget';
        run.error = attach.detail;
        await endTaskAttempt(store, originalGoal, stepId, 'pending', `step ${callId}: ${run.status}`);
        return { content: lastContent, lastRole, finalHandoff: handoff };
      }
      run.status = 'monitoring';
      // Full plan id — resumeMonitoredRun's endTaskAttempt uses it as the
      // tasks.md cursor (strips to the base role for its own traces/handoff).
      run.pendingMonitor = { monitorId: attach.monitorId, stepIndex: i, role: stepId };
      await endTaskAttempt(store, originalGoal, stepId, 'pending', `step ${callId}: attached, monitoring (${attach.monitorId})`);
      return { content: lastContent, lastRole, finalHandoff: handoff };
    }

    let callResult: GatedResult;
    let goalTokens = 0;
    let stepContent: string | undefined;

    if (role === 'scraper') {
      // Escalation step (P4b): its input is a URL extracted from the prior
      // handoff, not a text prompt — decideEscalation already confirmed one
      // exists before this step was ever inserted, but re-check defensively.
      const url = handoff ? extractFirstUrl(handoff) : null;
      if (!url) {
        run.status = 'failed';
        run.error = `Scraper step '${callId}' has no URL to fetch (escalation inserted without one — should not happen)`;
        await store.appendTrace({ runId: run.runId, role, type: 'error', data: { message: run.error } }).catch(() => {});
        await endTaskAttempt(store, originalGoal, stepId, 'failed', run.error);
        return { content: lastContent, lastRole, finalHandoff: handoff };
      }
      const scraperArgsHash = hashArgs({ url });
      if (await hasRepeatedSuccess(store, callId, scraperArgsHash)) {
        run.status = 'failed';
        run.error = `Repeat detected: step '${callId}' already completed with identical arguments (needs_user)`;
        await store.appendTrace({ runId: run.runId, role, type: 'error', data: { message: run.error } }).catch(() => {});
        await endTaskAttempt(store, originalGoal, stepId, 'failed', `repeat detected: ${run.error}`);
        return { content: lastContent, lastRole, finalHandoff: handoff };
      }
      await beginTaskAttempt(store, originalGoal, stepId, `step ${callId}: attempting via browser_tool (navigate+extract) on ${url}`);
      callResult = await runScraperStep(store, run, decl, role, callId, url, registryKey);
      stepContent = applyResearchResult(run, role, callResult, goalTokens, aborted).content;
    } else if (role === 'pdf') {
      // P4b pdf escalation (previously deferred): its input is a pdf ref
      // extracted from the prior handoff, resolved via resolvePdfRef — a
      // single synchronous call (unlike the scraper branch's navigate+
      // extract pair), so this is one ordinary gatedCall, not gatedDetach.
      const pdfRef = handoff ? extractFirstPdfRef(handoff) : null;
      if (!pdfRef) {
        run.status = 'failed';
        run.error = `pdf step '${callId}' has no pdf ref to resolve (escalation inserted without one — should not happen)`;
        await store.appendTrace({ runId: run.runId, role, type: 'error', data: { message: run.error } }).catch(() => {});
        await endTaskAttempt(store, originalGoal, stepId, 'failed', run.error);
        return { content: lastContent, lastRole, finalHandoff: handoff };
      }
      const pdfPayload = { uriPath: pdfRef, workspaceRoot };
      const pdfArgsHash = hashArgs(pdfPayload);
      if (await hasRepeatedSuccess(store, callId, pdfArgsHash)) {
        run.status = 'failed';
        run.error = `Repeat detected: step '${callId}' already completed with identical arguments (needs_user)`;
        await store.appendTrace({ runId: run.runId, role, type: 'error', data: { message: run.error } }).catch(() => {});
        await endTaskAttempt(store, originalGoal, stepId, 'failed', `repeat detected: ${run.error}`);
        return { content: lastContent, lastRole, finalHandoff: handoff };
      }
      await beginTaskAttempt(store, originalGoal, stepId, `step ${callId}: attempting via resolvePdfRef on ${pdfRef}`);
      callResult = await gatedCall(store, run, decl, role, 'pdf_read', undefined, pdfPayload, 500, callId, async () => {
        const { resolvePdfRef } = await import('../tools/use-free-llm.js');
        const resolved = await resolvePdfRef(pdfRef, workspaceRoot);
        // No throw on a miss — applyResearchResult's existing empty-content
        // handling (silent-zero fix) already turns '' into a clean 'failed'
        // status, same as every other tool here; a thrown error would skip
        // that path and bypass endTaskAttempt's normal bookkeeping.
        return { response: resolved?.resolvedContent ?? '' };
      });
      stepContent = applyResearchResult(run, role, callResult, goalTokens, aborted).content;
    } else {
      const stepGoal = stepInputText(i, originalGoal, handoff, i === startIndex ? memoryContext : undefined);
      const memoryBlock = buildSessionMemoryPromptBlock(await recentSessionMemory(store.runDirPath));
      const dispatch = resolveStepDispatch(decl, role, stepGoal, workspaceRoot, registryKey, memoryBlock);
      const argsHash = hashArgs(dispatch.payload);

      if (await hasRepeatedSuccess(store, callId, argsHash)) {
        run.status = 'failed';
        run.error = `Repeat detected: step '${callId}' already completed with identical arguments (needs_user)`;
        await store.appendTrace({ runId: run.runId, role, type: 'error', data: { message: run.error } }).catch(() => {});
        await endTaskAttempt(store, originalGoal, stepId, 'failed', `repeat detected: ${run.error}`);
        return { content: lastContent, lastRole, finalHandoff: handoff };
      }

      await beginTaskAttempt(store, originalGoal, stepId, `step ${callId}: attempting via ${dispatch.toolName}`);
      goalTokens = contextManager.countStringTokens(stepGoal);
      const estimate = goalTokens + 2000;
      callResult = await gatedCall(store, run, decl, role, dispatch.toolName, undefined, dispatch.payload, estimate, callId, dispatch.execute);

      // P4e trial-and-error (D5): a genuine failure (not a pause — needs_
      // approval/needs_budget already returned control to the human/budget
      // gate, they're not retried here) gets a bounded number of extra
      // attempts, each informed by past lessons for this exact role+tool.
      stepContent = applyResearchResult(run, role, callResult, goalTokens, aborted).content;
      const maxAttempts = Math.max(1, decl.limits?.maxAttemptsPerStep ?? 2);
      let attempt = 1;
      let statusAfterAttempt: HarnessRun['status'] = run.status;
      while (statusAfterAttempt === 'failed' && !aborted && attempt < maxAttempts) {
        attempt++;
        const failure: StepFailure = { runId: run.runId, role, tool: dispatch.toolName, failureKind: 'empty_result', detail: run.error ?? '', attempt };
        const lessons = await recallLessons(store, run, decl, role, dispatch.toolName, workspaceRoot);
        const [chosen] = await createReasoningStrategy(decl.reasoning?.strategy ?? 'heuristic').planAlternatives(failure, lessons);
        await writeLessonNode(store, run, decl, role, dispatch.toolName, failure.failureKind, chosen.strategy, workspaceRoot);

        const retryGoal = chosen.strategy === 'stricter-json-instruction'
          ? `${stepGoal}\n\nIMPORTANT: you must respond with substantive, non-empty content.`
          : stepGoal;
        const retryDispatch = resolveStepDispatch(decl, role, retryGoal, workspaceRoot, registryKey, memoryBlock);
        // No need to reset run.status/error here — the applyResearchResult
        // call right below unconditionally overwrites both from this new
        // attempt's callResult, whatever it turns out to be.
        callResult = await gatedCall(store, run, decl, role, retryDispatch.toolName, undefined, retryDispatch.payload, estimate, `${callId}:a${attempt}`, retryDispatch.execute);
        stepContent = applyResearchResult(run, role, callResult, goalTokens, aborted).content;
        statusAfterAttempt = run.status;

        if (statusAfterAttempt === 'complete') {
          const reused = lessons.find(l => l.strategy === chosen.strategy);
          if (reused) await reinforceLesson(store, run, decl, reused.id, workspaceRoot);
        }
      }

      if (run.status === 'complete' && stepContent && dispatch.toolName === 'use_free_llm') {
        const parsedTurn = parseTurnMemory(stepContent);
        if (parsedTurn) {
          await appendSessionMemory(store.runDirPath, { runId: run.runId, role, ...parsedTurn }).catch(() => {});
        }
      }
    }

    await endTaskAttempt(store, originalGoal, stepId, taskOutcomeFor(run.status), `step ${callId}: ${run.status}${run.error ? ` (${run.error})` : ''}`);

    if (run.status !== 'complete') {
      // paused_approval / paused_budget / failed / aborted — later steps stay
      // untouched (still 'pending' in tasks.md) so resume picks up here.
      return { content: lastContent ?? stepContent, lastRole, finalHandoff: handoff };
    }

    lastContent = stepContent;
    const provisionalIsLast = i === roles.length - 1;
    const provisionalNextTo = provisionalIsLast ? 'top_level' : stripCycleSuffix(roles[i + 1]);
    const built = buildHandoff(role, provisionalNextTo, stepContent ?? '');
    const validated = validateHandoff(built);
    if (!validated.ok) {
      run.status = 'failed';
      run.error = `Malformed handoff from step '${callId}': ${validated.error}`;
      await store.appendTrace({ runId: run.runId, role, type: 'error', data: { message: run.error } }).catch(() => {});
      await endTaskAttempt(store, originalGoal, stepId, 'failed', run.error);
      return { content: lastContent, lastRole, finalHandoff: handoff };
    }

    // P4b escalation: insert an 'html'-level scraper step right after this
    // one if confidence is low and a URL is actually available — mutates
    // `roles` in place, so tasks.md (seeded per-role via beginTaskAttempt at
    // the top of the loop) and resume's loadStepRoles both pick it up.
    const escalateTo = decideEscalation(decl, role, validated.handoff);
    if (escalateTo && roles[i + 1] !== escalateTo) {
      roles.splice(i + 1, 0, escalateTo);
      validated.handoff.to = escalateTo;
      validated.handoff.nextAction = `escalate to ${escalateTo} (confidence ${validated.handoff.confidence.toFixed(2)} below threshold)`;
    }

    await store.appendTrace({ runId: run.runId, role, type: 'handoff', data: validated.handoff }).catch(() => {});
    handoff = validated.handoff;

    const isLastStep = i === roles.length - 1; // re-check AFTER any splice above
    if (!isLastStep) run.status = 'running'; // more steps to go — applyResearchResult marked this one 'complete', but the RUN isn't done yet
  }

  return { content: lastContent, lastRole, finalHandoff: handoff };
}

/** P4f per-role tracking for top_level's own enrichment calls (recall/write-back) — the same bucket applyResearchResult writes to for research-lane steps, so supervisorShareMax reflects top_level's REAL total cost, not just its research-step share. */
function trackTopLevelTokens(run: HarnessRun, tokens: number): void {
  run.budget.used += tokens;
  run.budget.perRole = run.budget.perRole ?? {};
  run.budget.perRole.top_level = (run.budget.perRole.top_level ?? 0) + tokens;
}

/**
 * P4f wall-clock budget (D6/"Enforce what's declared-but-dead today":
 * maxWallMinutes). Checked once per step boundary — a step already in
 * flight isn't interrupted mid-call, matching the plan's own "checked
 * between steps" wording. `maxWallMinutes` unset/0 means no limit, same
 * "declaring nothing keeps old behavior" posture as the other P4e/P4f
 * additions.
 */
function wallBudgetExceeded(run: HarnessRun, decl: HarnessDeclaration): boolean {
  const maxWallMinutes = decl.harness.budget.maxWallMinutes;
  if (!maxWallMinutes) return false;
  return (Date.now() - run.createdAt) / 60000 > maxWallMinutes;
}

/**
 * P4f supervisor-share telemetry: WARNS via a trace event when top_level's
 * own share of total tokens exceeds supervisorShareMax — never blocks or
 * fails the run, since orchestration overhead being high is a signal to
 * look at, not by itself a budget violation the way maxTokens/maxToolCalls
 * are.
 */
async function checkSupervisorShare(store: HarnessStore, run: HarnessRun, decl: HarnessDeclaration): Promise<void> {
  const shareMax = decl.harness.budget.supervisorShareMax;
  const total = run.budget.used;
  const topLevel = run.budget.perRole?.top_level ?? 0;
  if (!shareMax || total <= 0) return;
  const share = topLevel / total;
  if (share > shareMax) {
    await store.appendTrace({
      runId: run.runId, role: 'top_level', type: 'budget',
      data: { reason: 'supervisor share exceeded', share, supervisorShareMax: shareMax, topLevelTokens: topLevel, totalTokens: total },
    }).catch(() => {});
  }
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
  // load_skill_prompt: prompt, browser_tool/extract: data — a
  // BrowserActionResult, string or structured) — checking only the
  // use_free_llm shape made every non-use_free_llm success look like an
  // empty result.
  const browserData = callResult.result?.data;
  const content: string =
    callResult.result?.choices?.[0]?.message?.content ??
    callResult.result?.response ??
    callResult.result?.prompt ??
    (typeof browserData === 'string' ? browserData : browserData ? JSON.stringify(browserData) : undefined) ??
    '';
  const stepTokens = contextManager.countStringTokens(content) + goalTokens;
  run.budget.used += stepTokens;
  // Per-role breakdown (P4f) — makes the supervisorShareMax metric real
  // instead of only declared config nobody reads; role was already in
  // scope here, just never recorded against it before.
  run.budget.perRole = run.budget.perRole ?? {};
  run.budget.perRole[role] = (run.budget.perRole[role] ?? 0) + stepTokens;
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
 * Shared tail for every entry point that runs the step loop to (possibly)
 * completion — deployHarness, resumeHarness, and resumeMonitoredRun (P5).
 * Factored out so all three apply the same write-back/eisenhower/
 * supervisor-share envelope on a 'complete' run, instead of three
 * hand-copied versions drifting apart over time.
 */
async function finishStepsAndEnvelope(
  store: HarnessStore,
  run: HarnessRun,
  decl: HarnessDeclaration,
  roles: string[],
  startIndex: number,
  goal: string,
  workspaceRoot: string | undefined,
  registryKey: string,
  aborted: boolean,
  priorHandoff: Handoff | undefined,
  memoryContext: string | undefined,
  recall: { recalledNodes: { id: string; content: string }[] } | undefined
): Promise<void> {
  const { content, finalHandoff } = await runSteps(store, run, decl, roles, startIndex, goal, workspaceRoot, registryKey, aborted, priorHandoff, memoryContext);
  if (run.status === 'complete' && content) {
    await writeBackToMemory(store, run, decl, goal, content, recall?.recalledNodes ?? [], workspaceRoot);
    if (finalHandoff) await submitOpenQuestions(store, run, decl, goal, finalHandoff, workspaceRoot);
    await checkSupervisorShare(store, run, decl);
  }
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

  // T2 — hash provenance: track this declaration in the workspace registry.json
  // and pin its path+sha256 on the run for later tamper checks. Best-effort:
  // a registry failure (locked dir, declaration module mocked without
  // resolveDeclarationPath in tests) must never block a deploy — the run
  // simply carries no provenance.
  let tracked: RegistryEntry | undefined;
  try {
    tracked = await trackDeclaration(input.harness ?? 'research-analysis', input.workspaceRoot);
  } catch { /* provenance is non-fatal */ }

  const run: HarnessRun = {
    runId: input.runId,
    harness: decl.harness.name,
    declarationName: input.harness ?? 'research-analysis',
    declarationPath: tracked?.path,
    declarationSha256: tracked?.sha256,
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
      const recall = await recallMemoryContext(store, run, decl, input.goal, input.workspaceRoot, registryKey);
      await finishStepsAndEnvelope(store, run, decl, roles, 0, input.goal, input.workspaceRoot, registryKey, runInfo.controller.signal.aborted, undefined, recall?.context, recall);
      await finalizeRun(store, run, registryKey);
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
 * Resumes a run parked in `monitoring` (P5) — checks MonitorRegistry for
 * the attached process's real state instead of blindly re-attempting
 * anything:
 *   - entry missing (registry lost it — e.g. a server restart, since
 *     MonitorRegistry is in-memory only): the run ends 'failed', never left
 *     silently 'monitoring' forever with no way to ever resolve it.
 *   - still 'running': no-op — returns the run unchanged; the caller polls
 *     monitor_tool or calls resume again later.
 *   - 'failed': the run ends 'failed' with the process's own error.
 *   - 'done': its result becomes this step's content, a real handoff is
 *     built from it, and the step loop continues from stepIndex+1 exactly
 *     like an ordinary step completing — the monitoring pause was
 *     transparent to every step after it.
 */
async function resumeMonitoredRun(store: HarnessStore, run: HarnessRun): Promise<HarnessRun> {
  const pending = run.pendingMonitor;
  if (!pending) {
    throw new Error(`Run '${run.runId}' has status 'monitoring' but no pendingMonitor recorded — this should not happen.`);
  }
  // T5 — pendingMonitor.role carries the FULL plan id (runSteps stored it
  // so this resume's endTaskAttempt lines up with that cycle's tasks.md
  // entry); every role-keyed surface below (traces, budget.perRole, the
  // handoff's from) speaks the BASE role, same as the loop does live.
  const pendingTaskId = pending.role;
  const pendingRole = stripCycleSuffix(pending.role);

  const registryKey = `harness:${run.runId}`;
  const decl = await loadHarnessDeclaration(run.declarationName, run.workspaceRoot);
  assertWorkspaceRootAllowed(decl, run.workspaceRoot);
  await verifyDeclarationIntegrity(run, store);

  const entry = MonitorRegistry.get(pending.monitorId);
  if (!entry) {
    run.status = 'failed';
    run.error = `Monitor '${pending.monitorId}' is no longer tracked (registry lost it, e.g. a server restart) — cannot resolve this step.`;
    run.pendingMonitor = undefined;
    await store.saveRun(run);
    await store.appendTrace({ runId: run.runId, role: pendingRole, type: 'error', data: { message: run.error } }).catch(() => {});
    await endTaskAttempt(store, run.goal, pendingTaskId, 'failed', run.error);
    await finalizeRun(store, run, registryKey);
    return run;
  }
  if (entry.status === 'running') {
    // P5c: still in flight — mid-flight WALL-CLOCK budget is checked here
    // (the one budget dimension that applies uniformly to any detached
    // process regardless of what it does). Token budget is deliberately
    // NOT checked mid-flight for this concrete detached user (cyber_tool's
    // osint scan): a web search call has no natural per-progress-event
    // token cost to settle against — D3's "if the event reports token/
    // resource usage" is conditional, and this one doesn't report any.
    // Pausing here is NOT resumable today — no code anywhere transitions a
    // run OUT of 'paused_budget' (a pre-existing gap, not new); pendingMonitor
    // is deliberately kept (not cleared) so a future resume-from-budget-pause
    // capability could still find its way back to this same monitor.
    if (wallBudgetExceeded(run, decl)) {
      run.status = 'paused_budget';
      run.error = `Wall-clock budget exceeded (maxWallMinutes: ${decl.harness.budget.maxWallMinutes}) while monitoring '${pending.monitorId}'`;
      await store.saveRun(run);
      await store.appendTrace({ runId: run.runId, role: pendingRole, type: 'budget', data: { reason: 'maxWallMinutes exceeded', monitorId: pending.monitorId } }).catch(() => {});
      return run;
    }
    return run; // still in flight, within budget — no-op, poll monitor_tool or resume again later
  }

  const roles = await loadStepRoles(store, decl, run.goal);

  if (entry.status === 'failed') {
    run.status = 'failed';
    run.error = entry.error || 'Detached process failed';
    run.pendingMonitor = undefined;
    await store.appendTrace({ runId: run.runId, role: pendingRole, type: 'monitor_done', data: { monitorId: pending.monitorId, status: 'failed', error: run.error } }).catch(() => {});
    await endTaskAttempt(store, run.goal, pendingTaskId, 'failed', run.error);
    await finalizeRun(store, run, registryKey);
    return run;
  }

  // entry.status === 'done'
  const content = typeof entry.result === 'string' ? entry.result : entry.result ? JSON.stringify(entry.result) : '';
  await store.appendTrace({ runId: run.runId, role: pendingRole, type: 'monitor_done', data: { monitorId: pending.monitorId, status: 'done' } }).catch(() => {});

  if (!content) {
    run.status = 'failed';
    run.error = 'Detached step completed without error but produced no content.';
    run.pendingMonitor = undefined;
    await endTaskAttempt(store, run.goal, pendingTaskId, 'failed', run.error);
    await finalizeRun(store, run, registryKey);
    return run;
  }

  const stepTokens = contextManager.countStringTokens(content);
  run.budget.used += stepTokens;
  run.budget.perRole = run.budget.perRole ?? {};
  run.budget.perRole[pendingRole] = (run.budget.perRole[pendingRole] ?? 0) + stepTokens;
  run.result = content;

  const nextTo = pending.stepIndex === roles.length - 1 ? 'top_level' : stripCycleSuffix(roles[pending.stepIndex + 1]);
  const built = buildHandoff(pendingRole, nextTo, content);
  const validated = validateHandoff(built);
  if (!validated.ok) {
    run.status = 'failed';
    run.error = `Malformed handoff from monitored step '${pending.monitorId}': ${validated.error}`;
    run.pendingMonitor = undefined;
    await store.appendTrace({ runId: run.runId, role: pendingRole, type: 'error', data: { message: run.error } }).catch(() => {});
    await endTaskAttempt(store, run.goal, pendingTaskId, 'failed', run.error);
    await finalizeRun(store, run, registryKey);
    return run;
  }
  await store.appendTrace({ runId: run.runId, role: pendingRole, type: 'handoff', data: validated.handoff }).catch(() => {});
  await endTaskAttempt(store, run.goal, pendingTaskId, 'completed', `monitor ${pending.monitorId} done`);

  run.status = 'running';
  run.pendingMonitor = undefined;
  await store.saveRun(run);

  const runInfo = RunRegistry.start(registryKey);
  (async () => {
    try {
      await finishStepsAndEnvelope(store, run, decl, roles, pending.stepIndex + 1, run.goal, run.workspaceRoot, registryKey, runInfo.controller.signal.aborted, validated.handoff, undefined, undefined);
      await finalizeRun(store, run, registryKey);
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
  if (run.status === 'monitoring') {
    return resumeMonitoredRun(store, run);
  }
  if (run.status !== 'paused_approval') {
    throw new Error(`Run '${runId}' is not paused for approval (status: '${run.status}')`);
  }

  const decl = await loadHarnessDeclaration(run.declarationName, run.workspaceRoot);
  // Re-validated on resume too — a declaration edited between deploy and
  // resume (e.g. allowedWorkspaceRoots tightened) must not grandfather in a
  // workspace_root that would no longer be permitted.
  assertWorkspaceRootAllowed(decl, run.workspaceRoot);
  // T2 — warn-trace only (never blocks): the file this run's policy came from
  // must still hash to what deploy recorded, or someone edited it mid-run.
  await verifyDeclarationIntegrity(run, store);
  // loadStepRoles (not planSteps) — the persisted tasks.md order, including
  // any step P4b's escalation dynamically inserted before this run paused,
  // which a fresh planSteps() call would have no way to know about.
  const roles = await loadStepRoles(store, decl, run.goal);
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
      // Recall only applies to a genuinely fresh first step — a resume
      // continuing from a later step already had its chance at step 0's
      // memory context on the original deploy.
      const recall = startIndex === 0 ? await recallMemoryContext(store, run, decl, run.goal, run.workspaceRoot, registryKey) : undefined;
      await finishStepsAndEnvelope(store, run, decl, roles, startIndex, run.goal, run.workspaceRoot, registryKey, runInfo.controller.signal.aborted, priorHandoff, recall?.context, recall);
      await finalizeRun(store, run, registryKey);
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

export interface ReorchestrateRoleInput {
  runId: string;
  role: string;
  workspaceRoot?: string;
  followupContext?: string;
}

export async function reorchestrateRole(input: ReorchestrateRoleInput): Promise<HarnessRun> {
  const store = new HarnessStore(input.runId, input.workspaceRoot);
  const run = await store.loadRun();
  if (!run) throw new Error(`No run found for runId '${input.runId}'`);

  const decl = await loadHarnessDeclaration(run.declarationName, input.workspaceRoot);
  assertWorkspaceRootAllowed(decl, input.workspaceRoot);
  await verifyDeclarationIntegrity(run, store);

  const rawTasks = await store.loadTasksMarkdown();
  if (!rawTasks) throw new Error(`Tasks file not found for run '${input.runId}'`);

  // Uncheck target role in tasks.md
  const updatedTasks = rawTasks.replace(new RegExp(`- \\[x\\] ${input.role}\\b`, 'i'), `- [ ] ${input.role}`);
  await store.saveTasksMarkdown(updatedTasks);

  await store.appendTrace({
    runId: run.runId,
    role: input.role,
    type: 'plan',
    data: { action: 'reorchestrate_role', followupContext: input.followupContext }
  });

  run.status = 'running';
  run.updatedAt = Date.now();
  run.error = undefined;
  await store.saveRun(run);

  const roles = await loadStepRoles(store, decl, run.goal);
  const registryKey = `harness:${run.runId}`;
  const runInfo = RunRegistry.start(registryKey);

  const roleIndex = roles.indexOf(input.role);
  const startIndex = roleIndex >= 0 ? roleIndex : 0;

  (async () => {
    try {
      const priorHandoff = await lastHandoff(store);
      const combinedGoal = input.followupContext ? `${run.goal}\n\n[Followup Instructions for ${input.role}]: ${input.followupContext}` : run.goal;
      await finishStepsAndEnvelope(store, run, decl, roles, startIndex, combinedGoal, input.workspaceRoot, registryKey, runInfo.controller.signal.aborted, priorHandoff, undefined, undefined);
      await finalizeRun(store, run, registryKey);
    } catch (err: any) {
      run.status = 'failed';
      run.error = err?.message || String(err);
      await finalizeRun(store, run, registryKey);
    }
  })().catch(() => {});

  return run;
}
