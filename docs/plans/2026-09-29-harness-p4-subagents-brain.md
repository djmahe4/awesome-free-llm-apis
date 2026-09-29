# Plan — Harness P4: subagents, research depth, brain, decay recall, trial-and-error, Eisenhower review

Branch: `feat/agent-harness` (after `5d00654`)
Builds on: [2026-09-29-agent-harness.md](2026-09-29-agent-harness.md) (P0–P3), audit in `mcp-server/docs/ai_harness_audit.md`.

## Where we are

What works today (verified by tests + live run): background runs, default-deny policy with bound approvals, resume after approval, workspace-root scoping, trace log, tasks.md blackboard (one task per run).

What the audit said doesn't exist, and still doesn't:

| Capability | Today |
|---|---|
| Subagents | One role per run, picked once by trigger words. The runner always calls `use_free_llm` whatever the role is, so `scraper` parks on an approval it can never satisfy and `coder` is unreachable. |
| Research | One plain chat call. No web search flag, no `browser_tool`, no `pdf://`, no abstract→html→pdf ladder (declared in YAML, never read). |
| Brain / wiki | `manage_memory` is never called. `writes` allowlist is dead config. |
| Decay recall | Ebbinghaus retention formula exists only in the browser (`dashboard/dag-blackboard.js`). Server never recalls or reinforces anything. |
| Trial and error | None. One straight shot per run. |
| Eisenhower review | Backend exists (`ProductivityMemory`, `eisenhower_*`), harness never uses it. |
| quantum_tool | Not referenced. |

## Self-review: inter-agent communication and handoff (current mechanism)

Honest assessment of what `runner.ts` calls a handoff today:

1. **It's synthetic.** The runner writes a handoff literal *after* the run finishes (`from: role, to: 'top_level'`). No subagent produces it, no agent consumes it.
2. **Confidence is fake.** Hardcoded `0.7`. `handoff.lowConfidenceThreshold` is never compared to anything.
3. **Findings aren't grounded.** `findings` is the first 500 chars of the reply with `source: 'use_free_llm'`. The reference spec requires every claim to cite a tool result / URL / `pdf://` ref.
4. **No schema.** There's no `Handoff` type in `types.ts` (the P0 plan declared one; never ported) and no validation, so nothing malformed can be rejected.
5. **No channel.** Handoffs only go to `trace.jsonl`. The next role can't read one, tasks.md doesn't reference one.
6. **No routing.** Roles don't decide the next role; there is no next role.
7. **No loop / depth guard.** `handoff.maxDepth` unused. Fine today only because there's one step.
8. **One fixed callId.** `'research-1'` for every run. Multi-step needs a per-step id that's deterministic, so resume replays the same step against the same approval.

Conclusion: the handoff is logging, not communication. P4 replaces it with a real step engine where each step's output is a validated handoff that the next step's input is built from.

## Design

### D1. Step engine (orchestrator = `top_level`)

A run becomes an ordered list of **steps**, each `{ index, role, tool, action?, buildArgs(ctx), parse(result) → Handoff }`. The lane (from the declaration's `primaryLane`) defines the pipeline. The research lane:

| # | Role | Tool | Purpose |
|---|---|---|---|
| 0 | top_level | `manage_memory` (`graph_query`, `adr_list`, `eisenhower_list`, `wiki_search`) | **Recall**: decayed-memory + prior decisions + open backlog relevant to the goal |
| 1 | researcher | `use_free_llm` (`google_search: true`) | **Search / abstract level**: candidate sources + first-pass claims, each with a URL |
| 2 | scraper | `browser_tool` (`navigate` → `extract`) | **HTML level**: only if step 1 confidence < threshold or sources lack detail; top-N URLs |
| 3 | researcher | `pdf_read` (wraps `resolvePdfRef`) | **PDF level**: only for `.pdf` sources, or when HTML failed |
| 4 | analyst | `use_free_llm` | **Synthesize**: grounded findings, open questions, decisions, confidence |
| 5 | top_level | `eisenhower_add` / `eisenhower_list` | **Eisenhower review**: triage open questions, order follow-ups |
| 6 | top_level | `manage_memory` (`wiki_write`, `adr_write`, `node_add`, `node_link`, `node_review`) | **Write-back + reinforce** |

Steps 2 and 3 are conditional, decided **deterministically** from the previous handoff (confidence vs threshold, URL extension, extraction success) — never an LLM choice, per the reference spec.

Each step:
- gets a **deterministic callId** `s{index}:{role}:{tool}` (resume replays the same id, same args hash → same approval);
- goes through `gatedCall` with its **real role**, so the allowlist actually applies per role;
- owns one task in tasks.md (`id = s{index}-{role}`), the task log records the handoff id;
- ends with a **validated `Handoff`** appended to `handoffs.jsonl`.

**Resume = cursor.** tasks.md is the cursor exactly like coding_agents: resume skips `completed` tasks and continues from the first non-completed one, rebuilding its args from the persisted handoffs of earlier steps (not from memory).

**Abort** is checked between steps (cooperative) and the signal is passed into `browser_tool` / LLM calls where they accept one.

### D2. Handoff contract (zod, versioned)

```ts
Handoff = {
  schemaVersion: 1,
  id, runId, stepIndex,
  from: Role, to: Role,
  status: 'in_progress' | 'blocked' | 'complete' | 'needs_user',
  confidence: number,                       // 0..1, computed (see below), never a literal
  findings: { claim: string; source: string; depth: 'abstract'|'html'|'pdf'|'memory' }[],  // source required
  openQuestions: string[],
  decisions: { title: string; rationale: string }[],   // feeds adr_write
  artifacts: string[],                       // urls, pdf:// refs, checkpoint paths
  nextAction: string,
  requiresApproval: { needed: boolean; action?: string; risk?: string },
}
```

- Validation failure → step marked failed, trace `error`, task stays `pending` (retryable), no silent acceptance.
- A finding without a `source` is dropped and counted; if all are dropped the handoff is `blocked`.
- **Confidence** is computed, not asked: share of findings with a verifiable source × depth weight (abstract 0.5, html 0.8, pdf 0.9, memory = node retention) × agreement across sources. The LLM's own self-rating, if parsed, can only lower it.
- LLM steps are asked for JSON matching the schema; parse failure gets **one** repair attempt, then the step fails (feeds trial-and-error, D5).

### D3. Brain: Ebbinghaus-decay recall and reinforcement

- Move the retention formula to one server-side util `src/memory/retention.ts` (`retention(node, now) = confidence · 2^(−days/halfLifeDays)`), and make `dag-blackboard.js` fetch it via the API rather than keeping its own copy — one source of truth.
- **Recall (step 0):** `graph_query`, score each node `relevance(goal) × (1 − retention)` for "due" items plus `relevance × retention` for "reliable" items; inject the top K of each (token-capped, compressed with `quantumCompressWithAnchors`) into the researcher's context as `depth: 'memory'` findings.
- **Write-back (step 6):** each grounded finding → `node_add` (tags: goal slug, depth, source host), linked to a goal node with `node_link`; synthesized page → `wiki_write`; each `decision` → `adr_write`.
- **Reinforcement:** recalled nodes that the analyst actually cited → `node_review` (resets decay, +confidence). Nodes contradicted by a newer source are not reviewed and get a `contradicted-by` edge.
- All of these are ordinary tool calls through `gatedCall`, allowed by the declaration's `writes` list — which stops being dead config.

### D4. Eisenhower review inside the agent

- Every `openQuestion` from the analyst handoff becomes an `eisenhower_add` task with **deterministic** flags: `urgent` = it blocks a step in this run (a needed depth level failed, or confidence < threshold on a core claim); `important` = it concerns a core claim of the goal (appears in ≥1 finding) rather than a tangent. `autoClassify` only if the declaration opts in (`review.autoClassify: true`) — off by default, per standing instruction.
- **Review step (5)** reads `eisenhower_list` for the run's tag and acts per quadrant:
  - `do` → becomes a follow-up step in this run if budget allows, otherwise surfaced as `needs_user`;
  - `schedule` → left in the backlog, noted in the final report;
  - `delegate` → spawns a scoped sub-run (`deploy` with its own runId, budget slice, same workspace scope) — this is the **subagent deployment** path;
  - `delete` → dropped, logged.
- Recall (step 0) also reads the backlog, so a later run on a related goal starts from unfinished `schedule` items.

### D5. Trial-and-error learning (+ quantum_tool stubs)

- On step failure (tool error, empty extract, schema fail, low confidence), write a **lesson** DAG node: `{role, tool, strategy, failureKind, contextSig}`, tag `lesson`, short half-life (7 days) so stale lessons fade.
- Before each step, recall lessons for the same `role+tool` with retention > 0.3 and pick a strategy that hasn't recently failed: e.g. search → reformulated query; html → different URL from the candidate list; pdf → next page range; schema fail → stricter JSON instruction.
- Bounded: `maxAttemptsPerStep` (default 2) in the declaration; each attempt is its own callId `s{i}:{role}:{tool}:a{n}` and its own task log line.
- Successful strategy after a failure → the lesson node gets `node_review` (reinforced), so it's preferred next time.
- **Quantum hook (stub only):** `src/harness/reasoning.ts` exports an interface

  ```ts
  interface ReasoningStrategy {
    planAlternatives(failure: StepFailure, lessons: DagNode[]): Promise<StrategyChoice[]>;  // trial-and-error branch generation
    scoreHypotheses(findings: Finding[]): Promise<{ claim: string; score: number }[]>;     // conflicting-claim adjudication
  }
  ```

  with `HeuristicStrategy` (the deterministic rules above, used now) and `QuantumStrategy` (stub: logs a `plan` trace event and delegates to `HeuristicStrategy`; TODO wires `quantum_tool` `setup` with `adversarial_debate` / `grover_amplification` presets and `analyze`). Selected by declaration `reasoning.strategy: heuristic | quantum`. No quantum_tool call is made in this phase.

### D6. Policy / declaration changes

```yaml
roles:
  researcher:
    tools:
      - { tool: use_free_llm, constraints: { agentic: false, google_search: true } }
      - { tool: pdf_read }
  scraper:
    tools:
      - { tool: browser_tool, actions: [navigate, snapshot, extract, checkpoint, session] }   # deep_scrape needs approval
  analyst:
    tools:
      - { tool: use_free_llm, constraints: { agentic: false } }
  top_level:
    tools:
      - { tool: manage_memory, actions: [graph_query, adr_list, eisenhower_list, wiki_search, wiki_read] }
writes:
  - { tool: manage_memory, actions: [wiki_write, adr_write, node_add, node_link, node_review, eisenhower_add] }
lanes:
  research: [recall, search, html?, pdf?, synthesize, review, writeback]
limits: { maxAttemptsPerStep: 2, maxDepth: 3, maxSubRuns: 2, maxUrlsPerStep: 3 }
review: { autoClassify: false }
reasoning: { strategy: heuristic }
```

- `pdf_read` is a harness-internal tool name mapped to `resolvePdfRef`; it goes through policy like any other.
- Tool invocation from the harness goes through one internal `invokeTool(name, args)` map (manage_memory, use_free_llm, browser_tool, pdf_read), not the MCP/REST switches — the harness is its own gateway.
- `coder` stays gated; it's only reachable via a `delegate` sub-run whose goal is a coding task, and every call still needs approval.
- Enforce what's declared-but-dead today: `maxWallMinutes` (checked between steps), per-role token accounting → `supervisorShareMax` warning, `maxDepth` for sub-runs.

### D7. Loop / sanity guards (self-review follow-through)

- Repeat detector: same `(role, tool, argsHash)` twice in a run → stop that branch, `needs_user`.
- Sub-run depth ≤ `maxDepth`, count ≤ `maxSubRuns`; a sub-run's budget is carved out of the parent's remaining budget (can't exceed it).
- Scraped content is data: it is placed in findings, never concatenated into a system prompt, and cannot name tools (defends against page-borne prompt injection triggering gated calls).

## Phases (each lands with tests, full suite green)

- **P4a — Step engine + handoff contract + per-role tool router.** Deterministic callIds, tasks.md cursor resume, zod handoffs, `invokeTool` map. Fixes scraper/coder reachability. Tests: fake tools; resume from middle step; malformed handoff rejected; repeat detector trips.
- **P4b — Research depth ladder.** google_search flag, browser `navigate`+`extract` on top URLs, `pdf_read`. Deterministic escalation rules. Tests: mocked `dispatchBrowserAction` / `resolvePdfRef`; ladder stops at abstract when confident; escalates on low confidence; pdf branch on `.pdf`.
- **P4c — Brain.** Server-side `retention.ts` (dashboard reuses it), recall step, write-back, reinforcement. Tests: due vs reliable ranking; cited nodes reviewed, uncited not; wiki/ADR/node writes go through policy.
- **P4d — Eisenhower review.** Deterministic flag derivation, per-quadrant actions, `delegate` → scoped sub-run. Tests: each quadrant's action; sub-run budget carve-out; autoClassify off unless declared.
- **P4e — Trial-and-error + reasoning stub.** Lesson nodes, strategy selection, bounded retries, `ReasoningStrategy` with heuristic impl + quantum stub. Tests: failed strategy not retried while lesson retention is high; successful retry reinforces lesson; quantum stub delegates and traces.
- **P4f — Limits + telemetry.** `maxWallMinutes`, per-role tokens + supervisor share, handoff/lesson/recall trace events, `tasks` action shows the full step list.

## Not in P4

- Actual quantum_tool calls (stub only).
- Dashboard UI for handoffs/steps (API only; the tasks/trace actions expose it).
- Closing `coding_agents`' own workspace-root gap (separate ask).
- Heuristic auto-approval of any kind.

## Open questions

1. Default `maxUrlsPerStep` (plan: 3) and `maxAttemptsPerStep` (plan: 2)?
2. Should `delegate` sub-runs need a human approval to spawn (safer), or be allowed within the parent's budget automatically?
3. Lesson half-life 7 days OK?
4. OK to make `dag-blackboard.js` call a server endpoint for retention instead of keeping its local formula?
