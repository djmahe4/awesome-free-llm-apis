# Plan — Background Agent Harness (HITL, allowlist, token budget, subagents)

Branch: `feat/agent-harness` (from `feat/coding-agents-dag-and-doc-filters` @ `fc4e523`)
Reference spec: "Research / Analysis Agent + Subagent Harness" system prompt (research-first, handoff contract, IaC declaration, coding gated).

## Goal

A harness that runs an agent **in the background** against this MCP server's own tools, with:

- a strict per-run **token budget**,
- **default-deny** tool permissions from a declarative allowlist (tool + action + argument constraints),
- a **HITL approval queue** for any call the allowlist doesn't cover — coding tools always land there,
- **structured, append-only trace logs** per run for debugging,
- **subagent deployment** (researcher, scraper, analyst, coder-gated) exchanging **structured handoffs**, not raw transcripts,
- an **IaC-style YAML declaration** of roles, tools, and policies.

Research/analysis/scraping is the primary lane; coding is an advanced, approval-gated lane.

## Grounding

### From the repo

| Primitive | Where | Reuse |
|---|---|---|
| Background runs keyed by sessionId, status/abort | `pipeline/middlewares/RunRegistry.ts` | Reuse as-is for harness runs (keyed `harness:<runId>`). In-memory only — harness must persist its own state to disk (see risk 2). |
| Subtask queues + HITL pause/`promptId` resume | `AgenticMiddleware.ts` (`nowQueue/nextQueue/blockedQueue/improveQueue`, `q.paused`, `q.promptId`) | Reuse the *pattern* (pause → id → resume), **not** the queues: the approval queue must be a separate store (see decision D2). |
| Cross-process provider locking | `utils/ProviderLockManager.ts` | Reuse; lease release must be in a `finally` for subagent failures (risk 6). |
| Token counting | `js-tiktoken` (dep), `ContextManager.countStringTokens` | Reuse for pre-call estimation. |
| YAML / schema validation | `yaml`, `zod` (deps) | Harness declaration parsing + handoff/allowlist schema validation. |
| Memory: wiki, ADR, DAG, Eisenhower | `manage_memory` | Handoffs and findings persist here; `adr_list`/`eisenhower_list` are the harness's pre-planning reads. |
| File locking | `utils/file-lock.ts` `withFileLock` | Approval-queue and trace writes. |

**Tool dispatch is duplicated.** `src/server.ts` (`/api/tool` switch) and `src/mcp/index.ts` (`name === ...` chain) each hand-map params per tool. They have already drifted: `server.ts` has no `browser_tool` case, and new `manage_memory` fields silently didn't reach the handler twice in the last branch because of the REST whitelist. A permission layer bolted onto either path alone is bypassable through the other. → Phase 0.

### From external research

- **Approval binding** (Microsoft Agent Framework, tool approval): an approval response only authorizes a call that matches a pending request recorded in the same session; unbound or replayed approvals are ignored. The harness middleware also supports standing "always approve" rules and optional heuristic auto-approval, all off by default. → D3.
- **Handoff cost** (AWS Well-Architected, AGENTCOST01-BP02): pass a structured summary (task, relevant facts, constraints), never the transcript; version the schema so receivers reject malformed handoffs; keep hierarchies ≤ 3 levels; supervisor tokens ≤ 20% of workflow tokens. → D4, budget metrics.
- **Structured context objects** run ~200–500 tokens vs 5–20k for forwarded history; cost grows quadratically with handoffs when history is forwarded.
- `use_free_llm` design-critique pass (gemini-3.1-flash-lite) — failure modes folded into Risks below; its suggestion to put pending approvals into `AgenticMiddleware.blockedQueue` is **rejected** (D2).

## Decisions

- **D1 — Single ToolGateway.** All tool execution (MCP handler, REST route, and harness) goes through one `ToolGateway.invoke(tool, params, ctx)`. Policy, budget, and tracing live there and nowhere else.
- **D2 — Approval queue is its own store**, not a subtask queue. A blocked tool call is a *pending decision about one call*, not a unit of planned work; mixing them makes starvation invisible (a queue of "subtasks" that are really waiting on a human) and conflates resume semantics.
- **D3 — Default-deny, bound approvals.** A call runs only if (a) an allowlist rule matches, or (b) a pending approval with the same `runId` + `callId` + `argsHash` was approved, or (c) a standing rule the user explicitly created matches. No heuristic auto-approval in v1.
- **D4 — Handoffs are versioned structured objects** validated with zod; malformed → rejected and traced, never silently accepted.
- **D5 — Budget is reserve-then-settle.** Before each LLM call, reserve `estimateInput + maxOutput`; refuse if it would exceed the run budget; settle to actual usage after. Fixes the "response tokens counted too late" overflow.
- **D6 — Research-first defaults.** Content depth order is deterministic (abstract → HTML → PDF), never an LLM choice. Coding tools are not in any default allowlist.

## Harness declaration (default)

`mcp-server/harness/research-analysis.yaml`

```yaml
harness:
  name: research-analysis-harness
  schemaVersion: 1
  primaryLane: research
  budget:
    maxTokens: 60000          # hard cap per run, all subagents combined
    maxToolCalls: 40
    maxWallMinutes: 20
    supervisorShareMax: 0.2   # warn if orchestration > 20% of tokens
  approval:
    timeoutMinutes: 60        # pending approval expires → call rejected, run continues or pauses
    standingRules: []         # user-created only, never pre-seeded

roles:
  top_level:
    tools:
      - { tool: manage_memory, actions: [search, wiki_search, wiki_read, adr_list, eisenhower_list, node_list, graph_query] }
      - { tool: use_free_llm, constraints: { agentic: false } }
  researcher:
    triggers: [research, arxiv, paper, "pdf://", literature, survey, analysis]
    tools:
      - { tool: use_free_llm, constraints: { agentic: false, google_search: true } }
      - { tool: vision_tool }
  scraper:
    triggers: [scrape, extract, crawl, table, list]
    tools:
      - { tool: browser_tool, actions: [navigate, snapshot, extract, deep_scrape, screenshot, checkpoint, session] }
  analyst:
    triggers: [compare, synthesize, critique, "key findings", limitations]
    tools:
      - { tool: use_free_llm, constraints: { agentic: false } }
  coder:
    requiresApproval: true    # every call queued, regardless of allowlist
    tools:
      - { tool: coding_agents }
      - { tool: local_llm_patch }

writes:                        # memory writes the harness may make without approval
  - { tool: manage_memory, actions: [wiki_write, adr_write, node_add, node_link, eisenhower_add] }

contentDepth: { order: [abstract, html, pdf], default: abstract }

handoff:
  schemaVersion: 1
  lowConfidenceThreshold: 0.7   # below → re-evaluate before continuing
  maxDepth: 3
```

## Data model

```ts
// harness/policy.ts
interface AllowRule { tool: string; actions?: string[]; constraints?: Record<string, unknown>; }
type Decision = { kind: 'allow'; rule: AllowRule } | { kind: 'needs_approval'; reason: string } | { kind: 'deny'; reason: string };

// harness/approvals.ts — persisted: .free-llm-mcp/harness/<runId>/approvals.json
interface ApprovalRequest {
  id: string; runId: string; callId: string; role: string;
  tool: string; action?: string; args: unknown; argsHash: string;   // sha256 of canonical JSON
  reason: string;                     // why it wasn't auto-allowed
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: number; decidedAt?: number; decidedBy?: string; note?: string;
}

// harness/trace.ts — append-only JSONL: .free-llm-mcp/harness/<runId>/trace.jsonl
interface TraceEvent {
  runId: string; seq: number; ts: number; role: string;
  type: 'run_start' | 'plan' | 'tool_call' | 'tool_result' | 'policy_decision'
      | 'approval_requested' | 'approval_decided' | 'budget' | 'handoff' | 'error' | 'run_end';
  data: unknown;                      // tool results truncated to N chars; full payload referenced by artifact path
  tokens?: { input: number; output: number; reservedRemaining: number };
}

// harness/handoff.ts
interface Handoff {
  schemaVersion: 1;
  from: string; to: string;
  status: 'in_progress' | 'blocked' | 'complete' | 'needs_user';
  confidence: number;                 // 0..1
  findings: { claim: string; source: string }[];   // every claim cites a tool result / URL / pdf:// ref
  openQuestions: string[];
  artifacts: string[];
  nextAction: string;
  requiresApproval: { needed: boolean; action?: string; risk?: string };
}

// harness/run.ts — persisted: .free-llm-mcp/harness/<runId>/run.json
interface HarnessRun {
  runId: string; harness: string; goal: string; workspaceRoot?: string;
  status: 'running' | 'paused_approval' | 'paused_budget' | 'complete' | 'failed' | 'aborted';
  budget: { maxTokens: number; used: number; reserved: number; toolCalls: number };
  queue: { role: string; task: string; handoffId?: string }[];
  handoffs: string[];                 // ids; bodies in handoffs.jsonl
  createdAt: number; updatedAt: number;
}
```

## Control surface

New MCP tool `agent_harness` (and matching REST route through the gateway):

| action | effect |
|---|---|
| `start` | `{ harness, goal, workspace_root, budgetOverride? }` → `{ runId, status: 'running' }` (background) |
| `status` | run + budget + queue + pending approvals count |
| `approvals` | list pending approvals (optionally for one run) |
| `approve` / `reject` | `{ approvalId, note?, standing? }` — `standing:true` creates a standing rule scoped to that exact tool+action+constraints |
| `trace` | tail/filter trace events for a run |
| `abort` | cancel via `RunRegistry.abort` |

Dashboard (later phase): Harness tab — runs list, live trace tail, approval queue with approve/reject buttons, budget bar.

## Phases

Each phase lands with tests and keeps the existing 694 passing.

**P0 — ToolGateway (prerequisite).**
Extract one registry `{ name → handler(params) }` used by both `mcp/index.ts` and `server.ts`. REST route stops hand-whitelisting params (pass through, validate with each tool's schema). Adds `browser_tool` to REST as a side effect.
Accept: every existing tool reachable identically through both paths; a test that enumerates MCP tool names and asserts each resolves through the gateway.

**P1 — Policy + approval queue + trace.**
`policy.evaluate(role, call)` from the YAML; `ApprovalQueue` (file-backed, `withFileLock`, bound by `runId+callId+argsHash`, expiry); `TraceLog` JSONL writer with per-event truncation and a per-run size cap.
Accept: unit tests for allow / needs_approval / deny; replayed approval (different argsHash) does not authorize; coder-role call always queued even if allowlisted; trace file is valid JSONL after a crash mid-write.

**P2 — Token budget.**
Reserve-then-settle around every LLM-backed gateway call; `maxToolCalls`; `maxWallMinutes`; pause (`paused_budget`) rather than fail when exhausted.
Accept: a run with a tiny budget pauses before the call that would exceed it, never after.

**P3 — Background runner + single researcher.**
`HarnessRunner` on `RunRegistry`, persisting `run.json` after every step so a restart can resume (RunRegistry is in-memory). One role (researcher), deterministic content-depth ladder, findings → `wiki_write`.
Accept: `start` returns immediately; `status` shows progress; kill/restart server → run resumes from `run.json` as `paused` (not silently lost, not duplicated).

**P4 — Handoffs + multi-subagent.**
Role routing by triggers; zod-validated handoffs; each subagent gets only the handoff + its role's tools (no transcript); `maxDepth` and a repeat-detector (same `to`+`nextAction` twice in a row → stop and surface `needs_user`); low-confidence re-evaluation; per-role token accounting for the supervisor-share metric.
Accept: scripted fake-LLM tests for researcher→analyst→top_level; malformed handoff rejected and traced; loop detector trips.

**P5 — HITL dashboard tab + `needs_user` surfacing.**

## Risks → mitigations

1. **Approval starvation** — run stalls silently on a pending approval. → `paused_approval` status visible in `status`, expiry, dashboard badge; run continues other queue items that don't depend on the pending call.
2. **In-memory/disk desync on restart** — `RunRegistry` lost, orphan "running" runs. → `run.json` is source of truth; on boot, any `running` run becomes `paused` with a trace event.
3. **Budget overshoot** — output tokens counted after the fact. → D5 reserve-then-settle.
4. **Handoff loops** — subagents ping-ponging. → `maxDepth`, repeat-detector, hard `maxToolCalls`.
5. **Approval fatigue** — too many prompts → rubber-stamping. → research/scrape/memory-write lanes allowlisted by default so the queue only carries genuinely risky calls; standing rules only by explicit user choice.
6. **Provider lock leaks** on subagent failure. → gateway wraps every call in `try/finally` release.
7. **Permission creep via arguments / prompt injection from scraped content** — a scraped page instructing the agent to call a gated tool. → constraints matched on canonical args, not regexes over free text; scraped content is data inside `findings`, never interpreted as instructions; gated tools can't be unlocked by anything the model writes, only by an approval record.
8. **Trace bloat** — unbounded JSONL. → per-event truncation, per-run size cap, artifacts referenced by path.

## Not in v1

- Heuristic auto-approval (only explicit allowlist + user-created standing rules).
- Automated rollback of tool side effects beyond what `coding_agents` already does.
- Dynamic budget scaling.
- Multi-process/multi-machine run distribution.
- Coding in the default lane at all.

## Side findings (separate fixes)

- `use_free_llm` appended the "🔑 Token-Efficient CLI Diagnostics (Debugger Mode)" block **twice** to one response, and selected the debugger persona for a design-review prompt. Worth a small fix in the persona/appendix injection before the harness starts leaning on `use_free_llm` for analysis output.

## Open questions

1. Approval surface for v1 — MCP tool only, or dashboard tab in the same PR as P1?
2. Should approved calls ever be allowed to create a standing rule from the dashboard, or MCP-only?
3. Default `maxTokens` per run (plan assumes 60k).
4. P0 is a real refactor of both dispatch paths — land it as its own PR first?
