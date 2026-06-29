# Changelog

## v1.0.6 – Vision, Skill Loading, Privacy Hardening + Provider/Routing Updates (May 2026)

### 🚀 Highlights

- Removed Kluster provider from runtime registration and environment/config usage.
- Added `vision_tool` for `file:///` workspace-local image analysis routed through `use_free_llm`.
- Added dynamic `load_skill_prompt` tool for remote skills index loading and integrated optional skill prompt injection via `use_free_llm.skill`.
- Hardened outbound privacy redaction for LLM-bound payloads (keys/tokens/emails/phones/cards/JWT/bearer strings).
- Added tool-call interception in `use_free_llm` to execute recognized tool-call payloads server-side and continue conversation.
- Hardened skill script generation with explicit delimiters (`@@@SKILL_SCRIPT_START@@@` / `@@@SKILL_SCRIPT_END@@@`), `.py` filename normalization, and metadata headers.
- Enforced Markdown-formatted output for `use_free_llm` and `free_llm_api`.
- Added line-by-line cosine similarity (TF-IDF based) in memory manager and workspace-index integration for similar-file diff summaries.
- Replaced fixed fallback `max_tokens` behavior with model-weighted token sizing utility.
- Updated Hugging Face routing behavior to treat it as credit-based and deprioritize it versus fully-free alternatives.
- Added `execute_skill` tool for executing prompts grounded in local skill instructions and reference files.
- Added `vision_tool` for analyzing local images or remote image URLs and pdf files with optional text prompts.
- Refactored providers and added 'modelscope' provider for free LLM access with dynamic model selection.
- Firebase telemetry integration for error monitoring, usage tracking, and alerting on anomalous patterns and dashboard setup to run all the tools as a chat interface. (Chat interface and conversation history is ther but tool call history is lacking and needs to be implemented in the next update.)

### 🔄 Refactoring & Robustness (Phases 1–5)

- **Decoupled Routing Layer**: Split the monolithic `IntelligentRouterMiddleware` into specialized `TextRouterMiddleware` and `ImageRouterMiddleware`.
- **Centralized Task Classification**: Created `TaskClassifier.ts` to house all prompt classification heuristics, improving execution speed and preventing vision model routing for text-based tasks.
- **Consolidated Middleware Directories**: Moved all middleware files from `src/middleware/agentic/` and other directories into `src/pipeline/middlewares/` and standardized their naming (e.g., `AgenticMiddleware.ts`, `StructuralMiddleware.ts`).
- **Resilient File Operations**: Added a retry-rename loop with backoff in `FileUtils.ts` to mitigate Windows file-locking issues (`EPERM`/`EBUSY`) during concurrent atomic writes.
- **Benchmark Harness & Performance Tracking**: Upgraded `generate-live-samples.ts` to run fully isolated with a mocked `LLMExecutor`, profile memory, and output a performance table in `SAMPLES.md`.

### Next updates
- **URL Context**: Planned support for direct URL consumption in the LLM pipeline by google or other llms if supported.
- Dashboard refactors to include tool call history and conversation history in a single view with filtering and search capabilities.
- Assess migration to stream mode for supported providers to reduce latency and token wastage on long responses.
- Reassess our architecture and apply fixes if required to make the system more robust and resilient to failures and also to make it more scalable and maintainable.

---

## v1.0.5 – Hedged Execution, Tool Consolidation + Workspace Persistence (May 2026)

**Released:** 2026-05-07 (Updated)

### 🚀 Highlights

- **Tool Consolidation**: Successfully deprecated and removed the legacy `store_memory` tool in favor of a structured workspace-aware architecture.
- **Structured Knowledge Harvesting (`store_workspace_skill`)**: Introduced a high-fidelity tool for explicitly capturing research findings, architectural decisions, and multi-step implementation details using the `@skill-writer` schema.
- **Proactive Workspace Indexing (`index_workspace`)**: Integrated deep semantic indexing of the entire codebase, enabling agents to operate with high-fidelity grounding without manual memory storage of code snippets.
- **Gemini-Exclusive Search Hardening**: Restricted Google Search capabilities to Gemini-based workflows, ensuring optimal performance and grounding through `gemini-2.5-flash`.
- **Search Suppression in Agentic Loops**: Implemented logic to disable Google Search for subsequent subtasks in a decomposed chain, preventing redundant lookups and token wastage.
- **Hedged Execution Strategy (`IntelligentRouterMiddleware`)**: Substantially reduces latency during partial provider outages by racing executing provider requests against a parallel timeout delayed request.
- **Graceful Execution Abortion**: Requests aborted due to successful parallel resolution automatically close open network sockets using `AbortController` signals to reduce token wastage.
- **Deep Reasoning Accommodations**: Automatically boosts `max_tokens` limits (up to 8192) and increases hedge delay parameters up to 20 seconds specifically for high-capacity models (DeepSeek-R1, O1, O3, Gemini Pro).
- **Agentic Pipeline Stabilization & Circular Dependency Resolution**: Successfully decoupled `AgenticMiddleware`, `LLMExecutor`, and tool-specific modules from the main `pipeline/index.js` barrel file. This eliminated runtime `TypeError` crashes and ensured reliable middleware initialization.
- **Optimized Routing for Semantic Tasks**: Adjusted the `IntelligentRouterMiddleware` to prioritize "lighter" models (e.g., Gemini Flash, Mistral Small) for `SemanticSearch` and `Summarization` tasks, significantly improving response speed for utility operations.
- **Test Suite Isolation**: Standardized `memoryManager.clear()` and `sharedResponseCache.flush()` in integration tests to ensure deterministic performance and prevent state bleeding across scenarios.
- **Documentation Overhaul**: Pruned legacy references to `code_mode` and `store_memory` from all public guides (`README.md`, `guide.md`, `SKILL.md`, `mcp-development.md`) to maintain a clean, agent-first interface.

### ✨ New Features

- **`store_workspace_skill` Tool**: Captures `what`, `why`, and `files` involved in a task to build a persistent, reusable skill database.
- **`index_workspace` Tool**: Manually triggers a vector re-index of the project root to ensure semantic search accuracy.
- **Type-Safe Tool Responses**: Implemented Discriminated Unions for workspace tool outputs to ensure reliable agent parsing.

### 🔧 Improvements

- **Zero-Config Session IDs**: Refined the deterministic `sessionId` derivation from `workspace_root`, ensuring stable persistence across restarts without manual ID management.
- **TypeScript Hardening**: Standardized response schemas for all persistent workspace tools.
- **Public API Cleanup**: Reduced the public tool count to six focused, high-impact utilities.

### ⚠️ Breaking Changes

- **REMOVED**: `store_memory` tool. Agents should migrate to `store_workspace_skill` for structured persistence or rely on `index_workspace` for semantic code retrieval.
- **DOCUMENTATION ONLY**: `code_mode` has been removed from all public documentation to favor cleaner agent interactions, although the underlying sandboxed runtime remains available in the codebase for internal use.

## Next update

- Remove the kluster from providers list(done)
- create  a ci workflow to automatically audit the providers for any depreciations and also to check if the models are still available and if not then we can replace them with the latest ones.(done)
- Add new 'vision_tool' to make use of free vision models to analyse images.(using `file:///` in `workspace_root` as the image path,Done)
- Add skill loading and prompt tool to make use of free skill loading agents to dynamically load and integrate the use of 'awesome-antigravity-skills' repo for agentic tasks and integrate it in the middleware without overhead.
- Add **Privacy-Sensitive Data redaction** for llm calls in middleware to prevent the leaking of sensitive data to third party free providers.(e.g. API Keys,passwords,PII, etc), partially implementeed by sanitize.ts but needs to be hardened and made more robust.(Done)
- Add mechanism to preserve the context of the conversation in case of a response like `\"read_file\". Let's try that.\n\n```json{\n  \"tool\": \"read_file\",\n  \"args\": {\n    \"path\": \"core/gemini_processor.py\"\n  }}```{\n  \"tool\": \"read_file\",\n  \"args\": {\n    \"path\": \"core/gemini_processor.py\"\n  }}` where the llm is explicitly asking to use a tool, we can preserve the context of the conversation and the intent of the user by not treating it as a normal response and instead directly calling the tool and returning its response to the llm without losing the context of the conversation.(Not implemented as of now but we can add a mechanism in the middleware to detect such responses and handle them accordingly by directly calling the tool and returning its response to the llm without losing the context of the conversation.)
- Make Skill script generation more robust: currently the generated skill script is enclosed in ````python\n{script}\n``` and is saved under _py instead of .py, we can make it more robust by using a more unique delimiter and also by adding some metadata to the generated script to make it easier to parse and use in the future.(fixed)
- `load_skill_prompt` tool to dynamically load the skill prompt from the 'awesome-antigravity-skills' repo  and also to integrate it in the middleware without overhead by adding a mechanism to cache the loaded skill prompts and also to update the cached skill prompts if there are any changes in the 'awesome-antigravity-skills' repo.
- Output to the agent should be in markdown format, not in json format.
- To be able to implement a line by line cosine similarity matching for very similar files and update memory with how both are different to avoid contextual confusions.(Improvise the memory manager to be more robust and also to be able to connect files in a project and be able to update the memory with the changes in the files and also to be able to use the memory to answer questions related to the project, integrate the usage of git diff, git log, etc to be able to keep the memory updated with the changes in the project and it shouldnt forget the workspace state after a simple git pull and checkout. Also use queues.json and make the knowlege.md the core of the memory and relate it with other files and docs to identify discrepancies and inform the user without wasting llm calls.)[Done but need enhancment what if the codebase is too large? Integrate with karathy]
- Post process 'free_llm_api' tool output to markdown format.
- Improve the middleware to be more robust and also observe and handle the edge cases where the llm is not able to generate the response inthe desired format.By logging and sending a firebase alert for such cases and also by adding a mechanism to handle such cases gracefully without breaking the flow of the conversation.(Note the firebase db itself is not implemented.It is to be implemented in v1.0.6 update.)
- Need a model weighted max_tokens for token calculation based on the model size and not a fixed value.(check if model names like 'gemma4-31b-e4b' or something triggers smaller max_tokens, what about timeout values, we can have a dynamic timeout value based on the model size and the task at hand, for example for a deep reasoning task we can have a higher timeout value and for a simple task we can have a lower timeout value.)
- Merge the parent repo but no new providers. Audit the models to check for depreciations. (not merged but audited)
- Update the prompt loading mechnism the postbuild job, NORT_STAR sub prompt is often loaded need the keywords to be specific enough to avoid loading the same prompt multiple times and also to avoid loading unnecessary prompts which are not needed for the task at hand. (Not implemented)
- Using karpathy's memory.md as the reference for memory management and implementation with memory maps to connect files in a project. 

## v1.0.4 – Hardened Resilience + Persistent Memory + structural Fix (April 2026)

**Released:** 2026-04-12 (Updated)

### 🚀 Highlights

- **Intelligent Router Hardening & Persistence**: Integrated discrete circuit-breaker stats (`failures`, `cooldownUntil`) into `PersistenceManager`. The router now "remembers" provider health across process restarts, eliminating "memory amnesia" for failing providers.
- **Adaptive Timeout Floor**: Implemented a mandatory 12s floor per model attempt in the routing cascade. This prevents late-stage fallbacks from receiving unworkable <2s timeouts, dramatically improving reliability in deep provider chains.
- **Soft Circuit Breaking**: Migrated from a binary "skip" model to a "penalty" model. Cooling-down providers are now deprioritized (Score: -0.5) instead of ignored, allowing them to serve as a last resort if no other models match task requirements.
- **Improved 400 Error Classification**: Refined context overflow detection to prevent false-positive compression on property errors.
- **Payload Sanitization**: Automatic stripping of internal metadata (e.g., `timeoutMs`) from outgoing LLM requests to ensure compatibility with strict schema providers like Groq.

- **Intelligent Router Task Matrix**: Expanded `autoClassify` logic into a high-fidelity classification engine supporting 9 distinct categories (Coding, Reasoning, Moderation, Classification, UserIntent, SemanticSearch, Summarization, EntityExtraction, Chat).
- **Dynamic Greedy Budgeting**: Implemented cross-provider timeout management that dynamically allocates time across the fallback cascade, preventing deadlocks while maximizing success probability.
- **Tiered Context Pressure Handling**: Introduced Tier 0/1/2 logic for extreme input pressure (100k+ characters), using parallel summarization and adaptive truncation to maintain critical context windows.
- **Fixed 'codeastral-latest' mode bug**: `code_mode` now features proper dynamic mode detection. The execution mode (`'chat'` | `'coding'` | `'research'`) is inferred automatically from code content and command description, replacing any hardcoded model references.
- **Artifact Awareness & Context Resolution**: Introduced a pre-processing pass in `use-free-llm.ts` that detects and inlines `file://` URIs and Markdown links. This allows the LLM to "see" referenced files directly in the user message.
- **Deterministic Local Summarization**: For large context files (>12k chars), implemented a TF-style (word-frequency) local summarization engine. This enables high-density context injection without external API calls or latency.
- **Structural Markdown Middleware**: New `StructuralMarkdownMiddleware` inserted as the first pipeline stage. For agentic requests it reads the full session memory (`data/projects/{sessionId}/`) and injects it into the user message, giving the LLM complete visibility into context on every turn.
- **Project Work Rule Enforcement**: Tool descriptions and all documentation (`README.md`, `guide.md`, `SKILL.md`) have been hardened to mandate `agentic: true` and `workspace_root` for repository-scoped tasks, preventing "context-blind" requests.
- **Logic Collision Fixes**: Resolved auto-classification collisions (e.g., 'classify' matching as 'coding' due to name overlap) to ensure deterministic routing for complex intents.
- **Global Usage Persistence**: Implemented a robust telemetry layer with atomic Read-Merge-Write synchronization. Tracks daily and lifetime metrics across process restarts and concurrent agents (Claude, ChatGPT, Antigravity).
- **Agentic Momentum Hardening**: Fixed a critical bug in `AgenticMiddleware` where `nowQueue` was aggressively cleared after any successful step. Multi-step plans now correctly persist and transition across turns.

### ✨ New Features

- **Classification Task Validation**: Fully implemented Moderation, UserIntent, and Reasoning task routing.
- **Context Summarization Engine**: Tier 1 fallback that compresses history when it exceeds 40% of the model's budget.
- `StructuralMarkdownMiddleware` (`src/middleware/agentic/structural-middleware.ts`) — registered as stage 1 in the pipeline
- `resolveFileRefs(content, workspaceRoot)` — v1.0.4 helper for inlining `file://` URIs with security boundaries
- `summarizeTextLocally(text, limit)` — zero-latency TF-style summarization for large files
- `writeToSessionMemory(sessionId, filePath, content)` helper in `code-mode.ts` — safe file persistence with path-traversal guard
- `detectMode(code, command)` in `code-mode.ts` — auto-detects `'coding'` | `'research'` mode
- `limitSubtasks(plan)` in `AgenticMiddleware` — hard cap of 4 subtasks
- **Global Usage Hub**: Real-time "Global Server Hub" summary in dashboard displaying today's vs lifetime request/token totals.
- `PersistenceManager` (`src/utils/PersistenceManager.ts`) — atomic file-based state management with temp-file swap safety.
- **Daily usage resets**: Local-time-aware logic that clears daily counters while preserving lifetime totals.
- **Persistence Verification Suite**: Added `tests/persistence.test.ts` to validate atomic merging and state recovery.
- **Test Matrix Expansion**: Added `tests/task-routing-matrix.test.ts` and `tests/context-resolution.test.ts` to verify the "Prompt → Task → Model" routing pipeline and file inlining logic.
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
- **Debounced Persistence Flushes**: `LLMExecutor` now uses a 2-second debounce for usage flushes to prevent I/O thrashing during heavy agentic sequences.
- **Logic Simplification**: Removed redundant `confidenceScore` mapping and added robust optional chaining (`?.`) across all middleware context lookups.

### ⚠️ Breaking Changes

- None. `code_mode` calls without `sessionId` or `mode` continue to work exactly as before (sandbox-only execution).

### Next updates

- Remove `code_mode` tool(make it deprecated and retain the code and just comment the integrations) and replace it with `code_review` which uses kluster ai
- Plan to integrate knowlege, plan and tasks in the agentic worklflow atleast one of them.
- Add image processeing which utilises free image apis within the `use_free_llm` tool.(using `file:///` in `workspace_root` as the image path)

