# `coding_agents`

**Purpose:** Autonomous multi-file refactoring and feature implementation engine implementing the **OMP (`oh-my-pi`)** architecture. Performs workspace scanning, VectorStore TF-IDF RAG file discovery, line-anchored `[PATH#SHA8]` snapshot diffing, AST symbol extraction, and polyglot compiler diagnostics verification.

**Input:**
```typescript
interface CodingAgentsInput {
  goal: string;                     // Goal description or refactoring directive (Required)
  workspaceRoot?: string;           // Workspace root path (defaults to cwd)
  dryRun?: boolean;                 // If true, returns diff preview without mutating disk (default true)
  topKFiles?: number;               // Max candidate files to rank via VectorStore RAG (default 5)
  sessionId?: string;               // Session identifier for audit logging and CAS snapshot caching
  verifyLspDiagnostics?: boolean;   // Run compiler diagnostics before completing plan (default true)
  astEditOps?: Array<{ pat: string; out: string }>; // Structural pattern rewrites with $$$VAR captures
  resolve?: {
    action: 'apply' | 'discard' | 'rollback'; // Transactional commit or rollback action
    checkpointId?: string;                    // Target checkpoint for rollback
  };
}
```

**Output:** `{ patchSummary, diagnostics, modifiedFiles, relevantFiles, applied, checkpointId?, restoredFiles?, error? }`

### Pipeline Lifecycle (`src/tools/coding-agents.ts`)
1. **Enumerate**: Scans candidate workspace files (`.ts`, `.js`, `.py`, `.go`, `.rs`, `.json`, etc.), skipping ignored directories (`node_modules`, `.git`, `dist`, `.venv`).
2. **Locate**: Ranks and selects relevant files using in-memory `VectorStore` TF-IDF cosine similarity.
3. **Anchor**: Generates `[PATH#SHA8]` content snapshot anchors to detect concurrent drift and guard against stale overwrites.
4. **Edit**: Executes structural AST pattern rewrites (`applyPatternRewrite` with `$$$VAR` captures) and invokes `localLlmPatch` for targeted diff generation.
5. **Verify**: Runs polyglot compiler and LSP diagnostics (`ts-morph` for TS/JS, `python ast.parse`, `go vet`, `rustc --error-format json`).
6. **Commit / Rollback**: On `resolve: { action: 'apply' }`, pre-creates a Content-Addressable Storage (CAS) checkpoint and writes atomic `.tmp` files. Instant rollback is supported via `resolve: { action: 'rollback', checkpointId }`.
