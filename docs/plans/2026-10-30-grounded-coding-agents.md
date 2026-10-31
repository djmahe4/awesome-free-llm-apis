# Grounded coding_agents: hypothesis blackboard, verified retrieval, continuous evaluation

Status: proposal (2026-10-30). Trial mode: every slice is behind a setting or env flag, so it can be rolled back after we measure it.

## Why

The goal is for coding_agents to be measurably harder to mislead than an agent that plans from memory. Today it is not, because the planner and the retrieval layer both pass unverified claims forward.

Findings from a code survey. Each finding was spot-checked in the source.

| # | Finding | Where |
|---|---|---|
| G1 | The planner sees only the goal and up to 60 file paths. It gets no file contents, wiki, or retrieval. | `src/tools/coding-agents/tasks.ts:71-79` |
| G2 | Nothing checks the plan's claims before editing. A `targetFile` the planner invents is treated as a new file. | `tasks.ts:105`, `pipeline.ts:356` |
| G3 | Retrieved vector hits lose their provenance. `semanticSearch` returns only `content` and drops `path`, `contentHash` and `timestamp`. The code-first sort then reads `metadata?.path`, which is always undefined, so the sort does nothing. | `src/memory/index.ts:250-259`, `WorkspaceContextMiddleware.ts:474-481` |
| G4 | Nothing checks staleness at use time. Vector items are whole-file profiles plus the first 2000 characters. `repo_graph.json` rebuilds only when HEAD changes, so uncommitted edits are invisible to it. The grep cache keeps snippets for 30 minutes. | `indexer.ts:116-134,177-196`, `context-gatherer.ts:56-59` |
| G5 | LLM-written wiki pages are never checked against the source. They are written from a graph-diff summary, confidence rises 0.15 on every rewrite, and an ADR is created automatically at 0.85. The pages are then fed back as context. | `wiki-maintainer.ts:229-264`, `wiki.ts:380-388`, `WorkspaceContextMiddleware.ts:509-560` |
| G6 | There is no reranking and no minimum-score threshold. The only distractor control is a 5-file cap and a character budget. | `context-gatherer.ts:388-400` |
| G7 | Post-edit checks are strong: TypeScript regression, import and duplicate-definition checks, verifyCommand before and after with rollback, and a repair loop. Pre-edit grounding is the weak side. | `generate-file-patch.ts`, `verify-guard.ts`, `repair-loop.ts` |

## What the literature supports

- **Mechanical citation checks block fabricated references.** A citation must name a real retrieved file and a valid line range ([2512.12117](https://arxiv.org/pdf/2512.12117)).
- **Filter distractors before generation rather than enlarging the context.** Retrieve wide, judge relevance per passage, keep the top-k ([RankRAG, 2407.02485](https://arxiv.org/html/2407.02485v1); [UNREAL, 2610.08463](https://arxiv.org/html/2610.08463)). We do this with a judge call or heuristics, not fine-tuning.
- **Pipeline-level fixtures and provenance metadata.** Most RAG failures are execution or configuration faults, a third of them two or more stages away from their symptom. The paper recommends known-good fixtures, provenance on chunks, and first-divergence localization ([2610.18567](https://arxiv.org/html/2610.18567)).
- **Check the trajectory, not only the final answer.** Hallucinations happen along the path ([2607.00895](https://arxiv.org/html/2607.00895v1)). Coding agents have strong test signals but weak retrieval and citation grounding ([2608.05179](https://arxiv.org/html/2608.05179v1)).
- **From the Antigravity brain survey (425 sessions).** Plans there have an "Open Questions" / "User Review Required" gate before any steps, and the walkthrough contains pasted command output. Only 1 of 50 plans states hypotheses explicitly. Copy the gate and the evidence habit, and add the explicit hypothesis rows.

## Design

### 1. Evidence objects with provenance (fixes G3, G4)

Every piece of retrieved context becomes an `Evidence` record:

```ts
interface Evidence {
  path: string;          // workspace-relative
  lines?: [number, number];
  contentHash: string;   // sha256 of the cited span (or file) at retrieval time
  source: 'grep' | 'vector' | 'graph' | 'wiki' | 'probe';
  retrievedAt: number;
  text: string;
}
```

- `semanticSearch` returns metadata with each hit. The code-first sort then starts working.
- `assertFresh(evidence)` re-hashes the span from disk just before prompt assembly. A mismatch drops the evidence or re-reads it, and a trace event records it.
- On a coding_agents run, the grep cache is invalidated when any file it cites has a newer mtime.

### 2. The wiki is claims, not facts (fixes G5)

- A wiki page written by the maintainer stores `sources: [{path, contentHash}]` for the files it summarises.
- When the page is read for context, a changed source hash marks it `unverified`. Unverified pages enter the prompt as "Unverified summary (source changed since written)", never as plain context, or they are left out under a setting.
- Confidence no longer rises on a plain rewrite. It rises only when a probe confirms a claim from the page (see section 3). Automatic ADR creation requires at least one confirmed claim.

### 3. Hypothesis blackboard (fixes G1, G2): the core

The plan step now runs in three phases.

1. **Ground.** Before planning, gather evidence: grep and graph for the goal terms, the vector top-N, and fresh wiki pages. Rerank (section 4) and pass file excerpts to the planner, not just paths.
2. **Plan with stated assumptions.** The planner returns tasks plus `hypotheses`. Each hypothesis is a claim the plan depends on, with a citation and a mechanical probe:

   ```markdown
   # Hypotheses: <goal>
   | id | claim | cites | probe | status | evidence |
   |----|-------|-------|-------|--------|----------|
   | h1 | `approve` requires `approvalId` | src/tools/agent-harness.ts:L80-L90 | grep:"approve.*requires `approvalId`" | confirmed | L81: if (!input.approvalId) throw ... |
   | h2 | `targetFile` src/utils/http.ts exports `httpGetJson` | src/utils/http.ts | symbol:httpGetJson@src/utils/http.ts | refuted | not exported (found: httpGet) |
   ```

   This is saved as `hypotheses.md` next to `tasks.md`, in the same `[task-N]`-keyed blackboard style.
3. **Validate.** A validation pass, done by a subagent or done in-process, runs every probe. Probe kinds are fixed and mechanical:
   - `file:<path>`: the path exists.
   - `symbol:<name>@<path>`: the name is defined or exported there (ts-morph for TS/JS; regex for py, go, rust).
   - `grep:<regex>@<path>`: the pattern matches inside the cited range.
   - `cite:<path>:Lx-Ly`: the range exists and its hash matches the evidence.
   - `cmd:<allowlisted command>`: exit code as claimed. This reuses `validateVerifyCommand`.
   - `test:<name>`: the test is currently passing or failing, as claimed.

   The LLM proposes only the claim and the probe. The probe result is computed and never written by a model.

**The gate.** `execute` is refused while any hypothesis is `open`. A `refuted` hypothesis goes back to the planner with its evidence for one re-plan, then the run pauses for the user, Antigravity-style. The setting `codingAgents.hypothesisGate` takes `off`, `warn` or `enforce` (default `warn` during the trial).

**Evidence-backed closure.** A task in `tasks.md` can be marked `[x]` only with an evidence line: the verify output, an exit code, or a probe id. The existing per-resume `log:` lines are extended for this.

### 4. Rerank before the prompt (fixes G6)

- Retrieve wide (around 30 candidates from grep, graph and vector). Score each one with:
  - a cheap lexical and structural score, matching identifiers in the goal and the hypotheses rather than just path tokens;
  - optionally, one small judge call over all candidates ("relevant: yes/no" per id, RankRAG-style), used only when a local model is available.
- Keep the top-k under the existing budget. Enforce a minimum score, and report dropped candidates in the trace.

### 5. Continuous evaluation (the "is it more robust" question)

Planted-hallucination fixtures, run by `scripts/smoke/` and in CI with a mocked model:

| Fixture | Planted fault | Pass condition |
|---|---|---|
| wrong-symbol | goal names `fetchUser` when the code has `getUser` | hypothesis refuted, plan corrected, no edit to a non-existent symbol |
| invented-file | planner targets `src/utils/helpers.ts`, which does not exist | `file:` probe refutes it before any write |
| stale-wiki | wiki page describes an old function signature | page marked unverified, not fed as plain context |
| stale-cache | file edited after the grep cache filled | stale evidence dropped (hash mismatch) |
| distractor | 30 near-miss files plus 1 relevant | relevant file in top-k after rerank |
| arity | plan assumes a two-argument call to a three-argument function | `symbol:` / arity probe refutes it |

Metrics over time are recorded in `scripts/smoke/results/`: hallucination-catch rate, false refutations, and added latency. We compare the gate off against the gate on, and keep each slice only if it improves catch rate without blowing the latency budget.

## First case: dashboard sync

Use the mechanism on the remaining item-10 work, filling `showFor` for browser_tool, cyber_tool, movie_tool and coding_agents. Each "action X needs input Y" is a hypothesis with a `grep:` or `symbol:` probe against the real handler. Only confirmed rows become `showFor` entries, and refuted rows are reported. This gives real hypotheses on our own code, and a check we already know the answer to (manage_memory and agent_harness were done by hand in PR #87).

## Slices (each its own branch from v1.1.2, test-first)

1. `feat/ca-evidence-provenance`: the `Evidence` type, metadata kept through `semanticSearch` (fixes the dead sort), `assertFresh`, grep cache mtime invalidation. Fixtures: stale-cache.
2. `feat/ca-hypothesis-probes`: the probe runner (file, symbol, grep, cite, cmd, test) with tests per probe kind; `hypotheses.md` serialize and parse.
3. `feat/ca-hypothesis-gate`: the planner returns hypotheses and gets excerpts (the Ground phase), validation, the gate setting, one re-plan on refutation. Fixtures: wrong-symbol, invented-file, arity.
4. `feat/dashboard-showfor-hypotheses`: the first case above.
5. `feat/wiki-claim-verification`: source hashes on pages, unverified marking, confidence only from confirmed probes. Fixture: stale-wiki.
6. `feat/ca-rerank`: wide retrieval, scoring, minimum score, optional judge. Fixture: distractor.
7. `feat/ca-eval-suite`: the fixture runner, metrics file, CI job with a mocked model.

## Risks

- **Latency.** Probes are local and mechanical, so they should be cheap. The judge rerank is the costly part and stays optional. We measure before keeping each slice.
- **Planner-proposed probes that test nothing.** The validator rejects probes that do not touch a cited file. The number of hypotheses per plan is capped.
- **False refutations blocking real work.** The gate defaults to `warn` during the trial, and a refuted row can be overridden explicitly with a reason.
