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
  dryRun?: boolean;                                 // If true, returns diff preview synchronously without mutating disk (default true)
  topKFiles?: number;                               // Max candidate files to rank via VectorStore RAG (default 5)
  sessionId?: string;                               // Session id for audit logging, CAS snapshot caching, tasks.md resume, and the background run key for status/abort
  verifyLspDiagnostics?: boolean;                   // Run compiler diagnostics before completing plan (default true)
  astEditOps?: Array<{ pat: string; out: string }>; // Structural pattern rewrites with $$$VAR captures — deterministic, no LLM involved
  resolve?: {
    action: 'apply' | 'rollback';                   // Transactional commit or rollback action
    checkpointId?: string;                          // Target checkpoint for rollback
  };
}
```

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
}
```

### Pipeline Lifecycle (`src/tools/coding-agents.ts`)
1. **DAG Plan / Pause / Resume**:
   - Calling with `action: 'plan'` or `pauseOnTaskPlan: true` creates a DAG checklist in `tasks.md` and pauses (`status: 'paused'`).
   - Calling with `action: 'resume'` extracts the next pending task (`- [ ]`), passes the full DAG context to the patch generator, marks it completed (`- [x]`), and updates `tasks.md` — the file's original goal header is preserved across resumes regardless of what `goal` string a given resume call passes.
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
6. **LLM Patch Generation & Refusal Guard**:
   - Tries local Ollama coder models first (5-minute per-model ceiling — generous since this now runs in the background rather than blocking a client call; still loops to the next candidate model on failure); seamlessly falls back to cloud coding models (`useFreeLLM`) when local models are unavailable or time out.
   - Injects active task and DAG checklist into prompt context.
   - Strictly intercepts canned refusals (e.g. `I'm sorry, but I can't assist with that request.`), preserves full failure message without slicing, logs an error diagnostic, and guides user to resume with `action: "resume"` or `astEditOps`.
7. **Polyglot Compiler Diagnostics & Verification**:
   - Runs `ts-morph` diagnostics for TS/JS, `python -c "import ast; ast.parse(...)"` for Python, `go vet ./...` for Go, and `rustc --error-format json` for Rust. Cleanly skips non-code files without warning noise.
8. **Transactional Commit / Rollback**:
   - Pre-creates Content-Addressable Storage (CAS) snapshots and writes atomic `.tmp` files. Supports instant single-call rollback via `resolve: { action: 'rollback', checkpointId }`.

