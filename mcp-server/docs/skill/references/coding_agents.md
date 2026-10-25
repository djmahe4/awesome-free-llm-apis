# `coding_agents`

**Purpose:** Autonomous multi-file refactoring and feature implementation engine implementing the **OMP (`oh-my-pi`)** architecture. Performs workspace scanning, VectorStore TF-IDF RAG file discovery, line-anchored `[PATH#SHA8]` snapshot diffing, AST symbol extraction, and polyglot compiler diagnostics verification.

**Input:**
```typescript
interface CodingAgentsInput {
  goal: string;                                     // Goal description or refactoring directive (Required)
  workspaceRoot?: string;                           // Workspace root path (defaults to cwd)
  targetFiles?: string[];                           // Explicit target files list (bypasses auto-scan and ts-morph for non-code)
  action?: 'plan' | 'execute' | 'resume' | 'status' | 'abort'; // Execution + DAG tasks.md + background-run control
  pauseOnTaskPlan?: boolean;                        // Same effect as action:'plan' — create tasks.md DAG and pause (default false)
  verifyReport?: { exitCode: number; output: string; command?: string }; // output of a check YOU ran (after the agent changed tests it never runs, or a withheld edit); failure => result.verification.repairBrief
  feedback?: string;                                // repairBrief from a failed attempt, appended to the goal for the retry
  verifyCommand?: string;                           // e.g. 'npx vitest run tests/a.test.ts'. Run before and after an apply; passed-before + fails-after => automatic rollback, failing output in result.verification.outputTail. Allowlisted runners, no shell syntax.
  dryRun?: boolean;                                 // If true, returns diff preview synchronously without mutating disk (default true)
  topKFiles?: number;                               // Max candidate files to rank via VectorStore RAG (default 5)
  sessionId?: string;                               // Session id for audit logging, CAS snapshot caching, tasks.md resume, and the background run key for status/abort
  verifyLspDiagnostics?: boolean;                   // Run compiler diagnostics before completing plan (default true)
  astEditOps?: Array<{ pat: string; out: string }>; // Structural pattern rewrites with $$$VAR captures — deterministic, no LLM involved
  resolve?: {
    action: 'apply' | 'rollback';                   // Transactional commit or rollback action
    checkpointId?: string;                          // Target checkpoint for rollback
  };
  // ── repair loop and generation (all optional) ──
  maxRepairAttempts?: number;                       // retries after a failed check or blocking review (default 4, max 5; AST edits never retry)
  samples?: number;                                 // independent first-round candidates from the original file, judged by verifyCommand (default 3 with a verifyCommand, max 5, 1 disables)
  maxDurationMs?: number;                           // wall-clock budget for the whole repair loop (default 300000 = 5 min); ends with outcome 'timed_out'
  review?: boolean;                                 // independent review of the diff before apply (default on; never runs when a verifyCommand exists)
  temperature?: number;                             // sampling temperature (default 0); the repair loop raises it on retries
  rewrite?: boolean;                                // regenerate a small file instead of patching it (set by the repair loop when many cases fail)
  model?: string;                                   // pin an installed local model, e.g. 'hf.co/empero-ai/Qwythos-9B-Claude-Mythos-5-1M-GGUF:Q4_K_M'; overrides llmfit, the router and the VRAM budget
  think?: 'off' | 'auto' | 'on';                    // reasoning for thinking models (default 'off'; 'auto' keeps it with reply-budget headroom)
  allowCloudFallback?: boolean;                     // let a failed local edit fall back to free cloud models (sends the file and goal to a third-party provider). Default false
  relatedFiles?: string[];                          // part of the change but not edited in this call (shown as API surface); set by the repair loop when it narrows a retry
}
```

**Workspace settings — `<workspaceRoot>/.free-llm-mcp/coding-agents.json`** (optional; agent patches can never write this file):
```jsonc
{
  // failing tests that do not count when judging a check: exact name, substring, or "/regex/flags".
  // A check whose only failures are listed is green; result.verification lists what was skipped.
  "skipFailingTests": ["flaky network call", "/^legacy snapshot \\d+$/", "test_needs_gpu"],
  // off by default: a failed local edit never goes to a cloud model unless this (or the call) allows it
  "allowCloudFallback": false
}
```
Use it for known pre-failing, flaky or environment-dependent tests, so they don't keep every check red and send the repair loop chasing them.

**Tracing (environment):** `CODING_AGENTS_TRACE=1` prints one stderr line per stage with elapsed time and Ollama's load / prompt / generation split; `CODING_AGENTS_TRACE_DIR=<dir>` also saves every rejected model reply there.

**Execution model — synchronous vs. background:**
`dryRun:true` (the default), `action:'plan'`/`pauseOnTaskPlan:true`, and `resolve.action:'rollback'` are all **synchronous** — you get a full result on that call.

Real execution (`dryRun:false`, not a plan-only call) runs **in the background** instead. Local/cloud LLM patch generation over several files — especially with a large goal or a large local model prompt — can legitimately take longer than a client's own tool-call timeout would tolerate, so the call returns immediately with `status:'running'` and the `sessionId`, and you poll:
```jsonc
// kick off
{ "goal": "...", "dryRun": false, "sessionId": "my-run-1" }
// → { status: "running", sessionId: "my-run-1", message: "Started coding_agents execution in the background..." }

// poll
{ "goal": "...", "sessionId": "my-run-1", "action": "status" }
// → { status: "running", message: "Running: 2/5 file(s) (last: src/foo.ts)" }
// ... eventually ...
// → the full final CodingAgentsResult (patchSummary, patchPlan, diagnostics, applied, ...)

// optional: cancel after the current file
{ "goal": "...", "sessionId": "my-run-1", "action": "abort" }
```
This mirrors `use_free_llm`'s `run`/`continue`/`status`/`abort` pattern (`RunRegistry`). Each `resume` call for a multi-task DAG goal (see below) independently follows the same dryRun-decides-sync-vs-background rule — a big task can background, a small/dry one won't.

**Output:**
```typescript
interface CodingAgentsResult {
  status?: 'applied' | 'rollback' | 'dry_run' | 'paused' | 'running';
  message?: string;              // Progress/ack text when status is 'running'
  patchSummary?: string;
  patchPlan?: LineAnchoredPatch[];
  diagnostics: DiagnosticResult[];
  relevantFiles: string[];
  wiringFiles?: string[];        // Automatically discovered barrels/consumers for new files
  tasksPlan?: TaskItem[];        // DAG tasks with completed/pending states
  tasksFile?: string;            // Created tasks.md
  isPaused?: boolean;
  applied: boolean;
  checkpointId?: string;
  restoredFiles?: string[];
  modelUsed?: string;
  usedFallbackModel?: boolean;
  error?: string;
  verification?: {               // present when a verifyCommand or verifyReport took part
    command: string;
    status: 'passed' | 'regressed' | 'not_green' | 'needs_user' | 'user_passed' | 'user_failed';
    ok: boolean; baselineOk: boolean; exitCode: number | null; timedOut: boolean;
    outputTail: string;
    failedCases?: string[];      // failing test names (node:test, vitest/jest, pytest, TAP)
    repairBrief?: string;        // debugger brief for the next attempt
    skippedFailures?: string[];  // failures ignored via skipFailingTests
  };
  repair?: {                     // how the automatic repair loop ended
    outcome: 'converged' | 'not_converged' | 'stuck' | 'needs_user' | 'error' | 'aborted' | 'timed_out';
    attemptCount: number;
    attempts: Array<{ attempt: number; outcome: string; failing?: number; rewrite?: boolean; brief?: string }>;
  };
  review?: { verdict: 'ok' | 'concerns' | 'blocked' | 'skipped'; findings: Array<{ blocking: boolean; text: string }> };
  rollbackBrief?: string;        // compiler messages of an edit that was rolled back for a syntax error
}
```

**Repair loop** (`src/tools/coding-agents/repair-loop.ts`, needs a `verifyCommand`):
- The tests named in `verifyCommand` are shown to the model read-only as the specification; the agent never edits or runs a test it wrote (such edits are withheld and you run them, reporting back with `verifyReport`).
- First round: `samples` independent candidates from the original file; the closest one (fewest failing cases) is repaired next. The original tree counts as a candidate too.
- Each retry gets a debugger brief: failing case names, assertion lines, stack frames in the edited files, plus targeted hints (a hard-coded test input, a numeric mismatch that suggests checking what a call returns, or a member read but never assigned such as `this.currency` / `self.currency`).
- More hints in the brief: a function called with different argument counts in one edited file (a half-finished signature change), and Python `takes N positional arguments but M were given` / `unexpected keyword argument`, which spell out "add the parameter to the definition".
- **Rejected before the check runs:** an edit that adds a second definition of an existing name (the later one wins; traced as the cause of a six-attempt stall) or an import that does not resolve is turned back into a retry with the reason, in the same attempt.
- **Localized retries:** a patch-in-place retry edits only the files the failure points at (a failing test named after the file, or a stack frame inside it); the other files stay as reference. A rewrite (many failing cases) starts again from the original and covers every file.
- Ends with `converged`, `not_converged` (budget spent), `stuck` (same failure even at the hottest temperature), `needs_user`, `error`, `aborted` or `timed_out`. If it never went green, the original files are restored.
- `abort` stops the loop after the attempt in flight and restores the original tree.

**Multi-file changes:** each file is edited in its own call; every prompt names the one file to edit and shows the other files' API surface (declaration/export lines), edited ones in their new form. Surfaces are language-aware: JS/TS, Python (`def`/`class`), Go (`func`/`type`), Rust (`fn`/`struct`/`impl`).

**Blackboard task shape (`tasks.md`):**
```typescript
interface TaskItem {
  id: string;
  task: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  targetFile?: string;   // planner-assigned file for this subtask
  context?: string;      // planner's why/what-not-to-break/dependencies note
  log?: string[];        // append-only: one line per resume attempt on this task
}
```
```
- [ ] [task-2] Add getDag() to MemoryManager
  - file: src/memory/index.ts
  - context: Mirrors getWiki(); depends on task-1 (dag.ts) already existing.
  - log:
    - 2026-09-28T09:12:03.000Z resume#1 files=[src/memory/index.ts] model=qwen2.5-coder:7b applied=false diagnostics=1 outcome=failed (see diagnostics)
```

### Pipeline Lifecycle (`src/tools/coding-agents.ts`)
1. **DAG Plan / Pause / Resume — with intelligent decomposition and a blackboard log**:
   - Calling with `action: 'plan'` or `pauseOnTaskPlan: true` decomposes the goal via a **cloud model** (`use_free_llm` — planning is a reasoning task, not code generation, so it does not go through `local_llm_patch`) into an ordered subtask list, each with a `targetFile` and a short `context` note (why this file, what not to break, dependencies on other subtasks), and writes it to `tasks.md` as a DAG checklist, then pauses (`status: 'paused'`). Falls back to a naive line-split decomposition if the planner call fails for any reason (unreachable providers, malformed JSON, empty goal) — plan creation never hard-fails just because the planner did.
   - Calling with `action: 'resume'` extracts the next pending task (`- [ ]`), folds its planner `context` into the goal text and scopes `targetFiles` to its `targetFile` (an explicit `targetFiles` on the call still wins), then runs the normal edit pipeline (Step 6 below — `local_llm_patch` first, cloud fallback only if that fails) against it.
   - **Blackboard, not just a checkbox**: every resume attempt appends a log line to that task — files touched, model used, `applied` outcome, diagnostic count, or the failure reason — this is the durable AI-agent ↔ `local_llm_patch` interaction history, not a transient in-memory thing. A resume that fails to produce a real patch (generation failure, or the hallucinated-replacement guard in Step 6) leaves the task **`pending`** (not `completed`) with the failure appended to its log, so the *next* `resume` retries the *same* task instead of silently moving on to the next one. Only a genuinely successful apply marks it `completed`.
   - The file's original goal header (`# Tasks Plan: ...`) is preserved across resumes regardless of what `goal` string a given resume call passes.
   - Poll a background run (see **Execution model** above) with `action: 'status'`; cancel one with `action: 'abort'`.
2. **Enumerate & Filter**:
   - Auto-scan strictly skips non-code directories (`docs/`, `documentation/`, `site/`, `wiki/`, `specs/`) and `.md` files to prevent false-positive RAG keyword matching.
   - Explicit `targetFiles` overrides allow targeting any file (including `.md`, `.html`, `.css`), safely bypassing TypeScript compiler passes.
3. **Automatic Wiring Discovery**:
   - When targeting non-existent files, `ContextGatherer` scans for parent barrel files (`index.ts`) and caller modules to recommend exact wiring targets.
4. **Anchor**:
   - Computes `[PATH#SHA8]` snapshot hash tags to prevent concurrent drift and stale overwrites.
5. **Polyglot AST & Structural Rewrites**:
   - **TypeScript / JavaScript**: Handled via in-memory `ts-morph` compiler AST for direct full-text output.
   - **Python, Rust, Go, C/C++, HTML, CSS, JSON**: Handled via `@ast-grep/cli` (`ast-grep` / `sg`) tree-sitter AST structural rewriting.
   - **Plain Text / Docs / Fallback**: Safe token regex with wildcard `$1..$n` capture replacement.
   - **Match Validation**: Warns in `diagnostics` if an AST edit pattern matched 0 occurrences.
6. **LLM Patch Generation — four-strategy escalation, each with its own guard**:
   Every strategy below can independently fail and falls through to the next; the first that produces a guard-passing result wins. Injects active task, its planner `context` (if resumed from a DAG task), and the DAG checklist into prompt context throughout. Strictly intercepts canned refusals (e.g. `I'm sorry, but I can't assist with that request.`) at every stage, preserves the full failure message without slicing, logs an error diagnostic, and guides the user to resume with `action: "resume"` or `astEditOps`.

   1. **SEARCH/REPLACE (local model)** — tried first. The model is shown the file (or a ~120-line window for large non-module files, via `extractWindowForInstruction`) as read-only context and asked to emit only `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` blocks — never full content. Unchanged text never passes through the model, so it structurally can't be collapsed, duplicated, or hallucinated the way full-content strategies can. Blocks are matched against the **full current file** by content (not the shown window) via `applySearchReplaceBlocks`, with three tiers of matching leniency (exact line match, then whitespace-trimmed line match) before a block is rejected as ambiguous or not-found. A block whose own SEARCH/REPLACE text contains a stray `<<<<<<<`/`=======`/`>>>>>>>` marker line (a tangled/malformed model response) is rejected outright rather than spliced into the file. For TS/JS files, an **error-delta gate** (`searchReplaceRegressesTsErrors`) runs the in-memory `ts-morph` checker before and after the whole batch and rejects it atomically if applying it would *increase* the real compiler error count — a batch of individually-plausible blocks can still combine into a worse-than-before file (observed live: fixing one method's signature without simultaneously updating its call sites turned 8 errors into 18), so acceptance is all-or-nothing per batch, not per block.
      The parser accepts what small models actually write: a block closed by a second `=======` or a bare `>>>>>>>`. If the model returns the whole edited excerpt instead of blocks (common for qwen2.5-coder:7b), the edit is recovered by diffing the excerpt against the original; SEARCH text always comes from the original, and lines dropped at the excerpt's edges are ignored. A REPLACE copied with the wrong indentation is shifted to the matched block's indentation. For an additive goal, a line that comes back changed (a new parameter) counts as modified, not dropped. The TS error-delta gate ignores errors caused only by the in-memory checker's missing environment (unresolved modules, node globals); instead, every import the edit **adds** is resolved against the real workspace (relative JS/TS files, installed packages, local Python modules), and a wrong one becomes the retry reason with the closest real file. If a reply cannot be used, SEARCH/REPLACE is retried once with the reason, before any slower strategy.
   2. **SEARCH/REPLACE (cloud fallback, opt-in)** — same mechanism as above via `useFreeLLM`, tried if the local attempt produces no usable blocks **and** `allowCloudFallback` is on (on the call or in the workspace settings). It sends the file to a third-party provider, so it is off by default; when off, the diagnostic says the fallback was skipped.
   3. **Full-content / windowed-splice (local model)** — the older strategy, kept as a second attempt for models that won't follow the SEARCH/REPLACE format. Full file for small files; a ~120-line window (same `extractWindowForInstruction`) spliced back for large non-module files. **Skipped for modules over 300 lines**: regenerating them is the slowest path (minutes on a 7B) and the one that drops or renames code; the repair loop retries instead. The reply budget is sized from the excerpt (1024–8192 tokens), not a fixed cap. Two extra guards here that SEARCH/REPLACE doesn't need: **window content-fidelity** (`windowReplyIsSuspicious`, multiset line-overlap comparison — catches a reply that collapses or duplicates the excerpt while keeping a plausible-looking total line count, which a naive line-count check misses) and the **hallucination guard** below.
   4. **Full-content / windowed-splice (cloud fallback, opt-in)** — same as (3) via `useFreeLLM`, tried last, only with `allowCloudFallback`.

   **Hallucination guard** (strategies 3–4, existing files only): if the LLM's "successful" output shares none of the original file's declared top-level symbols (or, for symbol-free files like CSS/HTML/classic scripts, less than half its original lines), the result is treated as an unrelated replacement — reverted to the original content, not applied, and logged the same way as a generation failure. Also rejects a stray leading `` ``` `` fence marker, and any *increase* in literal ASCII `...` occurrences vs. the original (real source in this repo only ever uses the single Unicode `…` character for genuine ellipsis text — a model eliding unchanged content with a literal three-dot placeholder is a reliable truncation signal independent of overall line-overlap).

   **Model candidate ranking** (`codeEditCandidates`, `src/tools/local-llm-patch.ts`): capability-aware order from the model router (code-specialised first); a pinned `model` goes first. Vision-language models (`vision`, `llava`, `*vl:*` naming) are excluded from the candidate pool entirely, not just deprioritized — this pipeline never sends image content, and in traced runs a VL fallback never produced a usable edit, only an extra model swap. Thinking models get `think:false` by default (in a 3-run cross-file comparison thinking had the same pass rate and was 4–7× slower); with `think:'auto'` they keep reasoning, get +3072 reply tokens of headroom, and a reply whose reasoning used the whole budget is retried once without thinking.

   When a SEARCH/REPLACE or full-content result is falling back to the next strategy, the reason is folded into the eventual diagnostic message (chained, not a separate diagnostic entry) so the escalation path is visible without needing to inspect logs.
7. **Polyglot Compiler Diagnostics & Verification**:
   - Runs `ts-morph` diagnostics for TS/JS, `python -c "import ast; ast.parse(...)"` for Python, `go vet ./...` for Go, and `rustc --error-format json` for Rust. Cleanly skips non-code files without warning noise.
8. **Transactional Commit / Rollback**:
   - Pre-creates Content-Addressable Storage (CAS) snapshots and writes atomic `.tmp` files. Supports instant single-call rollback via `resolve: { action: 'rollback', checkpointId }`.
   - **Automatic post-apply rollback**: if the diagnostics from Step 7 include a real syntax-level error (not the isolated per-file checker's known-noisy semantic ones, e.g. unresolved imports) after an apply, the checkpoint is restored automatically — including deleting any brand-new file the checkpoint can't restore — instead of leaving broken code on disk.
