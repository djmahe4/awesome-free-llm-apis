# Changelog

## v1.0.4 – Mode Fix + Structural Memory + Anti-Over-Iteration (April 2026)

**Released:** 2026-04-09

### 🚀 Highlights

- **Intelligent Router Task Matrix**: Expanded `autoClassify` logic into a high-fidelity classification engine supporting 9 distinct categories (Coding, Reasoning, Moderation, Classification, UserIntent, SemanticSearch, Summarization, EntityExtraction, Chat).
- **Dynamic Greedy Budgeting**: Implemented cross-provider timeout management that dynamically allocates time across the fallback cascade, preventing deadlocks while maximizing success probability.
- **Tiered Context Pressure Handling**: Introduced Tier 0/1/2 logic for extreme input pressure (100k+ characters), using parallel summarization and adaptive truncation to maintain critical context windows.
- **Fixed 'codeastral-latest' mode bug**: `code_mode` now features proper dynamic mode detection. The execution mode (`'chat'` | `'coding'` | `'research'`) is inferred automatically from code content and command description, replacing any hardcoded model references.
- **Added Structural Markdown Middleware**: New `StructuralMarkdownMiddleware` inserted as the first pipeline stage. For agentic requests it reads the full session memory (`data/projects/{sessionId}/`) and injects it into the user message, giving the LLM complete visibility into context on every turn.
- **Logic Collision Fixes**: Resolved auto-classification collisions (e.g., 'classify' matching as 'coding' due to name overlap) to ensure deterministic routing for complex intents.

### ✨ New Features

- **Classification Task Validation**: Fully implemented Moderation, UserIntent, and Reasoning task routing.
- **Context Summarization Engine**: Tier 1 fallback that compresses history when it exceeds 40% of the model's budget.
- `StructuralMarkdownMiddleware` (`src/middleware/agentic/structural-middleware.ts`) — registered as stage 1 in the pipeline
- `writeToSessionMemory(sessionId, filePath, content)` helper in `code-mode.ts` — safe file persistence with path-traversal guard
- `detectMode(code, command)` in `code-mode.ts` — auto-detects `'coding'` | `'research'` mode
- `limitSubtasks(plan)` in `AgenticMiddleware` — hard cap of 4 subtasks
- **Test Matrix Expansion**: Added `tests/task-routing-matrix.test.ts` to verify the "Prompt → Task → Model" routing pipeline across all 9 categories.
- **Dynamic Timeout Testing**: Switched test assertions to `expect.any(Number)` to support dynamic time budgets.

### 🔧 Improvements

- **Stability & Timeout Enforcement**: Implemented `AbortController` and `Promise.race` in `BaseProvider` for hard-stop guarantees.
- `CodeModeInput` now accepts optional `sessionId` and `mode` fields
- `CodeModeResult` now includes `mode` and optional `filesWritten` fields
- MCP server name version string bumped to `1.0.4`
- Pipeline middleware order updated: `StructuralMarkdownMiddleware` → `ResponseCacheMiddleware` → `AgenticMiddleware` → `IntelligentRouterMiddleware`
- **Security Hardening**: Implemented strict `sessionId` regex validation (`/^(?!\.\.?$)[\w\-\.]{1,128}$/`) and `path.resolve` prefix checks in `StructuralMarkdownMiddleware` to prevent unauthorized file access.
- **Multi-modal Robustness**: `StructuralMarkdownMiddleware` updated to handle complex message content (Array/Object) for visual/multi-modal compatibility.
- **Memory Optimization**: Migrated to `LRUCache` for session management (1000 entries, 1h TTL) with automatic `transport.close()` on eviction to prevent resource leaks.
- **Async Cache Initialization**: Refactored `ResponseCache` to eliminate synchronous file I/O during server startup, moving to a lazy-loading async `init()` pattern.
- **Logic Simplification**: Removed redundant `confidenceScore` mapping and added robust optional chaining (`?.`) across all middleware context lookups.

### ⚠️ Breaking Changes

- None. `code_mode` calls without `sessionId` or `mode` continue to work exactly as before (sandbox-only execution).

---

## v1.0.3 — High-Fidelity Benchmarking & Intelligence Refinement

**Released:** 2026-04-04

### 🚀 Highlights
- `code_mode` now supports **four sandbox runtimes**: JavaScript (QuickJS), Python (RestrictedPython), Go (goja), Rust (boa_engine)
- All six public tool descriptions **deeply enriched** with user stories, schemas, failure states, and concrete examples
- **Research validation logging** added to `AgenticMiddleware` — explicit audit trail for every detected external-knowledge request
- **New `mcp-server/README.md`** — Mermaid architecture diagram, full tool table, client configs, extension points
- All documentation synced: `guide.md`, `SKILL.md`, `usages.md`, `mcp-development.md`
- **New Benchmarking Suite**: Complete rewrite of `generate-live-samples.ts` to use real production middleware (Router, Context, Sandbox) instead of mocks.
- **7 Live Intelligence Scenarios**: Structured traces in `SAMPLES.md` covering Memory Synthesis, Task Decomposition, and sandboxed logic extraction.
- **Deterministic Keyword Steering**: Transitioned from fuzzy matching to a **Majority-Voting Classification** engine, enabling deterministic mapping of tasks to model tiers.
- **MCP Tool Interface Hardening**: Stripped 6 advanced/rarely-used parameters (`temperature`, `max_tokens`, `top_p`, `stream`, `provider`, `fallback`) from the `use_free_llm` schema to reduce agentic cognitive load.
- **Auto-Routing**: Made `model` parameter optional; the router now automatically selects the optimal tier based on `keywords` if no model ID is provided.
- **Simplified Response Payload**: Stripped heavy JSON wrapping from `use_free_llm` results; now returns raw assistant text for immediate agent consumption.
- **Multi-Choice Labeling**: Implemented `AGENT RESPONSE N` formatting for providers returning multiple completions (e.g., beam-search or `n > 1`).
- **Executor ↔ Compressor Bridge**: `LLMExecutor` now propagates real-time remaining token quota (from provider response headers) into `PipelineContext.providerRemainingTokens`. `ContextManager.compress()` reads this live signal to override its static model-window estimate, making context compression accurately reflect actual provider capacity.
- **Stricter Prompt Precision**: Selection threshold increased to `>= 3` to eliminate hallucinated prompt injections.
- **Granular Reference Mapping**: Metadata-aware link extraction capped at 5 high-relevance entries per section.
- **Adaptive Routing & Reactive Drift Correction**: Implemented provider cooldown penalties and a new robust error-interception layer. The system now detects 429 errors and rate-limit payloads (e.g., `resource_exhausted`) to immediately update internal token tracking, even for providers without standard headers.
- **Improved Router Precision**: Relaxed context window hard-blocks for explicitly requested models, ensuring they remain viable up to 0% headroom.
- **Verification Utilities**: Added `scripts/verify-header-extraction.ts` and `scripts/token-factor-smoke-test.ts` for live validation of provider rate-limit patterns and scoring logic.
- **Gemini Structured Output**: Added native JSON Schema support for Gemini via the `google-genai` Python SDK.
- **Google Search Grounding**: New `google_search` flag in `ChatRequest` enables real-time web grounding for Gemini models.
- **Intelligent Model Validation**: The router now strictly validates requested models against available providers before prioritization.
- **Multi-Language Sandbox Support**: Support for JavaScript (QuickJS), Python (RestrictedPython), Go (goja), Rust (boa_engine).
- **Subsystem Map Integration**: High-precision reference extraction for architectural momentum.

### ✨ New Features
- **Intake Protocol Documentation**: Detailed simulation of how agentic systems consume tool outputs in `benchmarks/SAMPLES.md`.
- **Live Trace Harness**: `npx tsx benchmarks/generate-live-samples.ts` now captures verified system state transitions.
- **Agentic Pipeline Observability**: Explicit `[RESEARCH-VALIDATION]` audit trails for external knowledge lookups.
- **Build Stability**: Resolved `NonSharedBuffer` TypeScript type-safety errors in sandbox execution logic.
- **Joint-Task Keyword Map**: Implemented high-precision mapping for `coding`, `research`, and `chat` task tiers in the Intelligent Router.
- **Majority-Voting Classifier**: New logic in `IntelligentRouterMiddleware` that counts keyword occurrences to resolve task ambiguity reliably.
- **Simplified Tool Description**: Rewrote `use_free_llm` instructions to prioritize "Intent-based Routing" through keywords over manual configuration.
- **Executor ↔ Compressor Bridge**: Added `providerRemainingTokens` to `PipelineContext`. After a successful API call, `LLMExecutor` writes the provider's remaining token quota from response headers into this field. `ContextManager.compress()` then uses `min(staticTarget, providerRemainingTokens)` as its effective budget. Providers without rate-limit headers degrade gracefully to the static estimate.
- **Stable Workspace Identity**: Switched `WorkspaceScanner` from transient content-hashing to stable **Identity Hashes** built from absolute paths. This fixes "memory amnesia" caused by code edits.
- **Anti-Poisoning Validation**: All workspace-aware tools now strictly validate the existence of `workspace_root` via `fs.existsSync`, preventing agents from hallucinating or poisoning phantom workspaces.
- **New `store_memory` Tool**: Implemented a dedicated tool for manual fact injection, enabling agents to explicitly persist architectural context and high-density summaries for subsequent runs.
- **Shared Memory Singleton**: Unified state management by migrating `MemoryManager` to a singleton pattern, resolving race conditions between tool calls and debounced disk persistence.
- **Gemini Search Tool**: Added explicit `google_search` tool call support in `gemini_client.py` for fact-grounded responses.

#### `code_mode` — Multi-Language Sandbox Support
- Added `language` parameter to `code_mode` tool: `"javascript"` | `"python"` | `"go"` | `"rust"`
- **JavaScript** (default): QuickJS via `quickjs-emscripten` — fully in-process, no subprocess overhead
- **Python**: New `scripts/python-sandbox-runner.py` using [RestrictedPython](https://restrictedpython.readthedocs.io/)
  - Blocks filesystem (`os`, `pathlib`, `io`, `shutil`, …), network (`socket`, `http`, `urllib`, …), and process (`subprocess`, `multiprocessing`, …) modules
  - Falls back to manual builtins restriction if RestrictedPython is not installed
  - `DATA` injected via `SANDBOX_DATA` environment variable
- **Go**: New `scripts/go-sandbox-runner/` — pure-Go ECMAScript engine via [goja](https://github.com/dop251/goja)
  - Executes JavaScript scripts in a Go subprocess
  - Timeout enforced via goroutine interrupt; `DATA`, `print()`, `console.log/error` all available
  - Build: `cd scripts/go-sandbox-runner && go build -o sandbox-runner .`
- **Rust**: New `scripts/rust-sandbox-runner/` — pure-Rust ECMAScript engine via [boa_engine](https://github.com/boa-dev/boa)
  - Executes JavaScript scripts in a Rust subprocess
  - Thread-local stdout/stderr capture; `DATA`, `print()`, `console.log/error` all available
  - Build: `cd scripts/rust-sandbox-runner && cargo build --release`

**Sandbox contract (all languages):**
```
INPUT:  code via stdin | DATA via SANDBOX_DATA env var
OUTPUT: print() / console.log() → stdout only
BLOCKS: filesystem, network, process/OS calls
```

#### Research Validation Logging in AgenticMiddleware
- `detectResearchIntent(content)` — regex-based detection of external-knowledge requests in user messages
- `logResearchValidation(sessionId, content, step)` — logs `[RESEARCH-VALIDATION]` entries with timestamp, session, and query preview
- Pre-execution log: fires when research intent is detected before the LLM call
- Post-execution log: fires after response to confirm grounding
- `verifySelf()` failures now also logged with `[VERIFY]` level warning

#### New `mcp-server/README.md`
- **Mermaid architecture diagram** of the full pipeline (Cache → AgenticMiddleware → Router → LLMExecutor)
- **Six-tool reference table** with required params and sample invocations
- **Middleware dataflow** prose explanation with best practices for agent/Copilot authors
- **"Add a provider in <20 lines"** walkthrough
- **Client configs** for Claude Desktop, Cursor, and Windsurf
- **Extension points** table: ReAct, Plan-and-Execute, Lite Mode, Cached-only strategies

---

### 🔧 Improvements

#### Tool Descriptions (`src/mcp/index.ts`)
All six tool descriptions have been rewritten to be self-documenting for agents:
- **User stories** — clear statement of when and why to use each tool
- **Input/output schemas** — explicit field-by-field documentation
- **Failure states** — what errors mean and how to recover
- **Concrete examples** — inline invocation examples in the description

#### Updated Benchmarks (`benchmarks/code-mode.bench.ts`)
Five realistic compression scenarios added:
1. **Chat Completions** — extract first message from 50-choice response (~95% savings)
2. **Model List** — extract names + availability from 62 models (~90% savings)
3. **Token Stats** — extract name + usage from 15 providers (~85% savings)
4. **Embeddings** — compute summary stats from 1536-dim vector (~99% savings)
5. **Search Results** — extract top-5 titles/URLs from 20 results (~92% savings)

Run: `npx vitest bench benchmarks/code-mode.bench.ts`

---

### 📚 Documentation Updates

| File | Changes |
|------|---------|
| `README.md` *(new)* | Full architecture overview, Mermaid diagram, tool table, client configs |
| `docs/guide.md` | Updated §4 (MCP Tools) with multi-language code_mode table and agent rules |
| `docs/mcp-development.md` | Expanded sandbox section: all 4 languages, Python allowlist, extension guide |
| `docs/skill/SKILL.md` | Updated `code_mode` reference with language table and `compressionRatio` note |
| `docs/skill/references/usages.md` | TC-05 rewritten with JS/Python examples and parameter table; TC-06 expanded with all four `manage_memory` actions; tool overview table updated |

---

### 🗂️ New Files

```
mcp-server/
├── README.md                                     ← new: agent-focused README
├── scripts/
│   ├── python-sandbox-runner.py                  ← new: RestrictedPython runner
│   ├── go-sandbox-runner/
│   │   ├── main.go                               ← new: goja-based JS sandbox
│   │   ├── go.mod                                ← new
│   │   └── go.sum                                ← new
│   └── rust-sandbox-runner/
│       ├── src/main.rs                           ← new: boa_engine JS sandbox
│       └── Cargo.toml                            ← new
```

---

### ⚠️ Breaking Changes
- None. The `language` parameter defaults to `"javascript"`, preserving full backward compatibility.
- Existing `code_mode` calls without `language` continue to work exactly as before.

---

### 🔨 Build Requirements for New Sandboxes

| Language | Requirement | Install |
|----------|------------|---------|
| `javascript` | none (bundled) | — |
| `python` | Python 3.x on PATH | `pip install RestrictedPython` |
| `go` | Go 1.21+, pre-built binary | `cd scripts/go-sandbox-runner && go build -o sandbox-runner .` |
| `rust` | Rust + Cargo, pre-built binary | `cd scripts/rust-sandbox-runner && cargo build --release` |

---


## Next Updates

- Infrastructure: Real-time visualization of Short-term memory buffers in dashboard.
- Documentation: Expand high-density synthesis examples for multi-agent workflows.
- **URL Context**: Planned support for direct URL consumption in the LLM pipeline by google or other llms if supported.
