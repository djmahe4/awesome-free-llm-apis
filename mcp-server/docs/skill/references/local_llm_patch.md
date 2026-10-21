# `local_llm_patch` [v1.1.1]

**Purpose:** Surgical code patch generator driven primarily by a local Ollama server (`http://localhost:11434`, no auth) with automatic fallback integration in `coding_agents`. Supports editing existing files or creating new ones, backed by `ContextGatherer` workspace context.

**Input:**
```typescript
interface LocalLlmPatchInput {
  filePath: string;          // Target file path to patch or create (Required)
  instruction: string;       // Precise patch instructions or refactor goals (Required)
  workspace_root?: string;   // Workspace root directory (defaults to dirname of filePath)
  sessionId?: string;        // Session identifier for context tracking
  allowCreate?: boolean;     // If true, creates brand new file if it does not exist (default true)
  contentOverride?: string;  // Caller-supplied excerpt to send instead of reading the full file from disk
  excerptRange?: { startLine: number; endLine: number; totalLines: number }; // Required alongside contentOverride — drives the excerpt-specific prompt wording
  outputFormat?: 'full' | 'search-replace'; // 'full' (default) asks for complete new file/excerpt content; 'search-replace' asks for <<<<<<< SEARCH/=======/>>>>>>> REPLACE blocks instead — see coding_agents.md's Step 6
}
```

**Output:** `{ success, filePath?, isNewFile?, modelUsed?, usedFallbackModel?, patch?, error? }`. In `'search-replace'` mode, `patch` is the model's raw block text (for the caller to parse/apply), not file content.

### Flow (`src/tools/local-llm-patch.ts`)
1. **Model Discovery & Ranking**: Lists local Ollama models via `listLocalModels()` (5s timeout) and ranks coding-specialized candidates (`qwen*-coder`, `deepseek-coder`, `codellama`, `devstral`) ahead of the rest. Vision-language models (`vision`, `llava`, `*vl:*` naming) are **excluded outright**, not just deprioritized — this tool never sends image content, and a vision model that entered the fallback pool for a strict-format text request (observed live: `qwen2.5vl:3b`) degenerated into a repetition loop instead of producing usable output.
2. **Context Enrichment**: Injects relevant workspace snippets via `ContextGatherer.gatherContext()` (grep + 1-hop neighborhood) — skipped when `excerptRange` is set, since a windowed excerpt is already scoped to the relevant region.
3. **Execution**: Queries ranked candidates sequentially via `chatLocal()`, each bounded by a 5-minute per-model timeout (an `AbortController` — a hung/misbehaving model now fails cleanly and falls through to the next candidate instead of hanging the whole call indefinitely). When called through `coding_agents`, this loop runs in the background — see `coding_agents.md`'s execution model.
4. **Refusal Interception**: Detects canned safety refusals (`I'm sorry, but I can't assist with that request.` / `I am unable to assist`) and rejects them as errors rather than treating refusal text as code.
5. **Clean Patch Extraction**: Strips enclosing markdown code fences (`'full'` mode) and returns the complete file replacement — or, in `'search-replace'` mode, returns the raw block text unstripped (the format explicitly forbids a code fence).
6. **Integration with `coding_agents`**: Serves as the primary local patch generator within `coding_agents` — tried first with `outputFormat: 'search-replace'`, falling back to `'full'` (windowed for large non-module files) if no block parses/matches, then to cloud coding models if Ollama is unreachable or every local strategy fails. See `coding_agents.md`'s Step 6 for the full escalation order and the guards each stage runs.

