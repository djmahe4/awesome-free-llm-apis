# Changelog

## v1.1.2 – Grounded coding_agents, Hardened Browser/Harness/Cyber/Skills, Per-Action Dashboard Inputs, JSON Context Reduction & Provider Updates (October 2026)

### 🚀 Highlights

- **Grounded `coding_agents`: checking the plan against the code before editing** (`src/tools/coding-agents/hypotheses.ts`, `hypothesis-gate.ts`, `hypothesis-model.ts`, `src/memory/evidence.ts`, `src/memory/wiki-claims.ts`, `src/pipeline/middlewares/rerank.ts`):
  - **Evidence provenance.** Vector hits keep the file path, content hash and index time (`memoryManager.searchWithProvenance`). Entries for files edited or deleted since indexing are dropped before they reach a prompt, and the grep/graph context cache is discarded when a file it quotes (including `RELATED FILE` graph snippets) changed.
  - **Hypotheses and probes.** The assumptions a goal makes (target files exist, named functions are defined) are written to `hypotheses.md` next to `tasks.md` and checked mechanically with `file:`, `defined:`, `symbol:`, `arity:`, `grep:`, `cite:`, `cmd:` and `test:` probes. The status is computed from the files; a status a person or a model writes is ignored.
  - **Hypothesis gate.** `hypothesisGate` in `.free-llm-mcp/coding-agents.json` (or `CODING_AGENTS_HYPOTHESIS_GATE`) is `off`, `warn` (default) or `enforce`. In `enforce`, a refuted assumption returns `status: "paused"` with `Blocked before editing` before any model call or edit. The `plan` action runs the same check.
  - **Optional model layer** (`hypothesisModel`, off by default): the model proposes extra assumptions (claim and probe only, never commands) and, in `enforce`, corrects a refuted goal once, using the names that do exist. A refuted model-proposed row is reported but never blocks. Returned as `replannedGoal`.
  - **People can edit the blackboard.** Rows with an id starting `u` and notes around the table survive the next run and are re-checked; a typed status is never believed. `cmd:`/`test:` rows run only when `hypothesisExec` is set, for the commands `verifyCommand` allows.
  - **Wiki claims.** A wiki page can carry a claims table that is re-checked on every write; pages with a refuted claim are tagged `unverified`. `WIKI_CLAIM_VERIFICATION=enforce` stops confidence rising and automatic ADRs without a confirmed claim (default `warn` only tags).
  - **Rerank before the file cap.** Grep candidates are scored by how rare the goal's terms are across them, so the file holding a distinctive name is no longer cut off by thirty files sharing common words. `CONTEXT_RERANK=off` restores the previous order.
  - **Continuous evaluation.** `npm run eval:grounding` runs eight fixtures that plant hallucinations and check they are caught (wrong symbol, invented file, wrong argument count, stale cache, stale wiki claim, distractors, human edits, the model layer with a mocked model, and gate off versus on) and fails if a fixture fails or loses checks, if the catch rate falls, or if the false-block rate rises. CI runs it after the tests.

- **`coding_agents` edit quality** (measured on live runs, several marked trial in their commits):
  - Bounded repair loop with reviewer and tests-as-spec, `verifyCommand` gate that rolls back edits that break a passing check, n-candidate first round where the tests pick among independent samples, repair briefs that name the failing file, call-arity and unassigned-member problems (TypeScript, Python, Go, Rust), rejection of an edit that adds a second definition of an existing name, `skipFailingTests` setting, and thinking off by default for code edits.
  - Capability-aware local model router (vision, code, embedding) with an `llmfit` hook, now bounded by `CODING_AGENTS_LLMFIT_MS` so a cold probe cannot stall a run; timed-out checkers are reported instead of looking clean.

- **Dashboard playground shows only the inputs an action uses** (`dashboard/js/00-field-visibility.js`, `04-playground-form.js`): per-action `showFor` for `manage_memory`, `agent_harness`, `browser_tool`, `cyber_tool`, `movie_tool` and `coding_agents`, backed by 58 checked claims about the handlers. This exposed and fixed gaps: `movie_tool update_artifact_bounds` was missing from the schema enum, playground and Quickstart; `movie_tool generate_assets` needed a `prompt` field; `browser_tool` could not send `params` or `outputDir`; `movie_tool.md` documented actions that do not exist.

- **Context reduction for large JSON** (`src/utils/json-reduce.ts`): oversized JSON responses are reduced to fit the context (keeping the fields the question needs) instead of being refused or cut off. `HTTP_MAX_JSON_BYTES` bounds what is parsed (default 25 MB).

### 🔒 Security and reliability

- Skills cannot read or write outside their folder; OSINT targets use the shared SSRF guard; `local_llm_patch` stays inside `workspace_root`; `register_tool` and tool names are validated and registry writes are locked and atomic; remaining state paths follow `FREE_LLM_MCP_HOME`; npm advisories cleared (including a `minimatch` override that keeps `ts-morph` at 28).
- `manage_memory` namespaces that could escape the wiki folder are rejected, and all parameters are forwarded.
- `agent_harness`: policy requires named bridges and always gates code-editing tools; approvals are single-use and validate the run; the wall budget counts active time; paused runs resume; abort stops a running run; optional `HARNESS_RESTRICT_ROOTS` boundary.
- `browser_tool`: unsafe URLs are refused before Chrome is launched; output paths stay inside allowed roots; `evaluate` is limited (`BROWSER_ALLOW_EVALUATE`); call timeouts and retries; one launch per session; block detection needs a wall rather than a mention; advertised-but-unimplemented options are refused. `BROWSER_ALLOW_HOSTS` and `BROWSER_ALLOW_PRIVATE` control local targets.
- `cyber_tool`: a failed model call leaves a DAG node pending, failed wiki saves are reported, `resolve_tool` sessions are bounded, OSINT cache is bounded with parallel DNS, GitHub token and rate-limit handling.
- Wiki page names no longer collide for punctuation-only titles.

### 🧪 Tooling

- Pre-commit now also checks: every tool-handler input is in its MCP schema, dashboard parameter gaps (ratchet), reference docs describe every result and settings key (ratchet), and tests that create temp directories remove them. Windows CI no longer fails on `ENOTEMPTY`.
- CI skips the `onnxruntime-node` CUDA download on the CPU-only runner; the dashboard drift check compares content, not line endings.

### 🌐 Providers

- Added Gonka Broker and OVHcloud AI Endpoints; SiliconFlow region via `SILICONFLOW_BASE_URL`; upstream model changes registered with benchmark-referenced scores; `data.json` validated on pull requests; README regenerated from `data.json`.

### Notes

- New settings are all off or at the previous behaviour by default except `hypothesisGate`, which defaults to `warn` (reports, never stops a run).

### 🔭 Next (v1.1.3 and later)

Planned in `docs/plans/rev_tool.md` (each phase is its own branch, cut after this release):

- **`reverse_tool`**, starting with the proxy to the pinned `rea-agents` package (handshake, tool allowlist, output cap, tree-kill, threat-model tests), then JavaScript and artifact analysis, GitHub release-asset scanning, GGUF inspection (`inspect_gguf`, `extract_layer`, `analyze_layer`) and `probe_memorization`. Authorization framing (`ctf` / `lab` / `consent`) applies to analysis of third-party artifacts.
- **`movie_tool`**: `separate_stems` and `smooth_stems` (Demucs only), then `animate_still` (depth-based parallax). Every feature keeps a 6 GB VRAM ceiling with a CPU fallback, and memory figures are published only after they are measured.
- **`agent_harness`**: capability validation for tool runs and a lightweight way to follow agent thoughts during subtasks without extra compute.

Follow-ups to this release:

- **Reranking**: a minimum-score cut-off and an optional model judge pass, added only after the evaluation suite shows they help.
- **Grounding evaluation**: the gate catch-rate set is small and written by us; a larger set built from real failed runs, and a measurement of how often the model corrects a goal correctly (one provider, one goal so far).
- **Dependencies**: the open Dependabot major bumps (`zod` 4, `vitest` 5, Node 26 base image, `actions/setup-python` 7) will be rebased onto the new `main` and taken one at a time.

## v1.1.1 – Multi-Lane Movie Generation Pipeline, Multi-Agent Harness, DAG Subtask Blackboard, Cyber URL Autoloading, Hybrid PQC Wiki & Modular Dashboard (October 2026)

### 🚀 Highlights

- **`movie_tool` & Multi-Lane Media Generation Pipeline** (`src/tools/movie-tool.ts`, `src/tools/movie/`):
  - Multi-track timeline orchestration engine (`video`, `audio`, `voice`, `effects`, `subtitles`) with JSON timeline manifests, frame-accurate positioning, and non-destructive asset layer composition.
  - Dedicated media routers across free provider tiers for image/video generation (Wan 2.1, LTX-Video, Pollinations, Hugging Face Hub), music synthesis, audio effects, and neural text-to-speech (Kokoro ONNX weights auto-fetched in postbuild).
  - Built-in audio DSP remix plugin suite (`tempo`, `pitch`, `reverb`, `eq`, `volume`, `compressor`, `fade`) with chained atempo filters and full undo/redo state tracking (`_path_history`, `effectId`).
  - Interactive Movie Studio UI with dynamic timeline stretching, audio oscilloscope visualization, timeline ruler scrubbing, and REST endpoint aliases (`/api/movie/*`).

- **`agent_harness` Multi-Agent Orchestration & Governance Engine** (`src/tools/agent-harness.ts`, `src/harness/`):
  - Production-grade multi-agent execution framework with external declaration auto-discovery (`harness.yaml`), role assignment, and multi-lane execution cycles.
  - Fine-grained role governance with `AGENTS.md` per-role skill allowlists, step engines with validated artifact handoffs, and strict default-deny policies locking `bridges.json` and harness configurations against unauthorized modification.
  - Eisenhower review loop with automated priority ranking, quantum-compressed trace summaries, and cognitive Ebbinghaus memory recall with write-back reinforcement.
  - Multi-stage research depth ladder (escalating from paper abstracts to deep HTML/PDF analysis) and multi-branch quantum reasoning trial-and-error exploration.

- **`coding_agents` Subtask Blackboard & Multi-Tier Patching** (`src/tools/coding-agents.ts`, `src/tools/coding/`):
  - Intelligent LLM-driven subtask decomposition with shared `tasks.md` blackboard state, task dependency analysis, and interactive SVG DAG memory graph visualization.
  - Multi-strategy code patcher: fuzzy `SEARCH/REPLACE` block application, sliding-window chunk patching with content-fidelity hallucination guards, and structural `ast-grep` rewrites.
  - Multi-language AST diagnostics verification (TypeScript/JavaScript, Python, Go, Rust), CAS per-file revision history tracking, rollback action (`undo_file`), and cross-process provider locking.

- **`cyber_tool` Intelligent Loading, Package Resolution & Bridge Isolation** (`src/tools/cyber-tool.ts`, `src/utils/CyberToolsRegistry.ts`, `src/utils/GithubRepoScanner.ts`):
  - Intelligent cyber tool URL auto-detection distinguishing GitHub repositories, Docker Hub images, apt package registries, and generic web tools.
  - New `resolve_tool` action providing repo understanding, package registry discovery, installation instructions, and automated tool registration.
  - Sandboxed execution bridge (`cyber_tool run_action`) with authorized framing gates and fail-closed bridge root containment.
  - Built-in global cyber security binary database (`nmap`, `sqlmap`, `hydra`, `gobuster`, `ffuf`, `nikto`) with automatic flag and troubleshooting documentation seeding for `wiki_lookup`.
  - DAG-reverse coach mode for iterative pentesting and CTF hypothesis traversal.

- **Hybrid Post-Quantum Cryptography (PQC) & Wiki Security** (`src/server.ts`, `src/memory/wiki.ts`):
  - Gated dashboard wiki APIs behind hybrid Post-Quantum Cryptography (PQC) lease tokens with strict origin validation, token expiry, and anti-replay guards.
  - Modular wiki workspace architecture supporting typed bidirectional links, journal logs, and isolated storage namespaces.

- **Modularized Dashboard Architecture & Progressive Disclosure** (`dashboard/`):
  - Re-architected monolithic `index.html` and `app.js` into structured partials (`dashboard/partials/*.html`) and modular JS components (`dashboard/js/*.js`), compiled deterministically via `scripts/assemble-index.ts`.
  - Unified canvas physics, interactive 2.5D visualizer, lightning state bus, domain mode switcher, and collapsible progressive disclosure cards across all dashboard tabs.
  - Fixed tool response log truncation and standardized real-time MCP tool call rendering.

- **Provider Catalog Expansion & Resilient Model Routing**:
  - Added new free providers: AionLabs and Pollinations (with community models); refreshed active model catalogs and limits for Cloudflare, Groq, OpenRouter, ModelScope, Kilocode, Hugging Face, Cohere, Gemini, and NVIDIA NIM.
  - Automated `taskRouteMap` synchronization with dynamic vision route derivation and isolated roleplay model filters.
  - Resilient `SubtaskDecomposer` multi-path project state persistence supporting directory fallbacks across restricted Windows filesystem environments.

- **Precommit Verifier & Test Suite Hardening**:
  - Enforced comprehensive `npm run verify:precommit` quality gate: TypeScript build checks, byte-for-byte partial assembly validation, parameter schema matching, documentation model count parity, and zero npm audit vulnerabilities.
  - Stabilized and isolated tests across `agentic-lazy-context-resolution`, `avst-tools-permutations`, `cyber-tool-dag`, `cyber-wiki`, and `encryption`.

### Next updates (→ v1.1.2)

- `movie_tool` reverse enginneering of video/audio and images and entity or element extraction from frames for multi-lane generation.
- **Comprehensive End-to-End Smoke Test Suite**:
  - Automated live API smoke test harness covering Ollama (local daemon at `http://localhost:11434` and Ollama Cloud), NVIDIA NIM, Groq, ModelScope, OpenRouter, and Pollinations.
  - Dedicated JSONL streaming decoder smoke tests for local Ollama and streaming-capable providers within `coding_agents` and `use_free_llm`.
  - Headless smoke test runner integrated into CI workflows with automatic mock fallbacks when live credentials are not present.
- **Streaming Pipeline Middleware & Latency Optimization**:
  - Native AsyncIterable / Server-Sent Events (SSE) streaming pipeline through `TextRouterMiddleware` and `AgenticMiddleware` to minimize time-to-first-token latency.
  - Dynamic per-provider rate-limit and circuit breaker backoff utilizing HTTP 429 `Retry-After` headers and rolling latency telemetry.
- **Multi-Modal Cross-Lane Pipeline Piping**:
  - Direct asset piping between `SearchRouterMiddleware`, `browser_tool`, and `movie_tool` for automated contextual asset harvesting and script synthesis.
  - Subtree-targeted DOM scraping with visual bounding box correlation for `browser_tool`.
- **Sandbox Security & Process Isolation**:
  - Lightweight sandboxed process runner for external tool bridges and code evaluation to prevent profile permission collisions (`EPERM`) across Windows and Unix environments.

---

## v1.1.0 – Autonomous Coding Agents (OMP Pattern), Intelligent Session Naming, Local LLM Patching, OSINT Cyber Recon, VectorStore TF-IDF RAG & Dashboard Tool Docs (August 2026)

### 🚀 Highlights

- **Intelligent Conversation Auto-Naming (`extractIntelligentTitle`)** (`src/utils/ChatLogger.ts`, `src/server.ts`):
  - Automatically extracts 3–6 word human-readable conversation titles from the first tool output or assistant response, stripping markdown headers, emojis, code blocks, and conversational filler (`"Sure! I can help you with that..."`).
  - Appends the workspace unique identifier in brackets: `[<workspace-basename>]` or `[none]` (e.g. `"Vulnerability Assessment Report [awesome-free-llm-apis]"` or `"Quantum State Superposition [none]"`).
  - Automatically writes title metadata to `name.txt` upon completing the first turn, or dynamically derives on-the-fly when reading logs.
- **Multi-Tool Session Retrospection & Continuation**:
  - Unified `sessionId` inheritance and tracking across all 14 tools (`use_free_llm`, `cyber_tool`, `quantum_tool`, `vision_tool`, `coding_agents`, `execute_skill`, `local_llm_patch`).
  - Running different tools consecutively now threads into a coherent project timeline in the chat log rather than fragmented, isolated sessions.
- **Explicit `+ New Chat` Creation & Renaming Endpoints** (`dashboard/index.html`, `dashboard/app.js`, `src/server.ts`):
  - Added `+ New` button directly in the Conversations sidebar header (`#pg-new-conv-btn`) for starting isolated sessions on demand.
  - Added `POST /api/sessions` (supports creating fresh sessions with workspace bindings) and `PATCH /api/sessions/:sessionId` (supports conversation renaming).
  - Eliminates silent session orphaning caused by typing or modifying workspace path input strings.
- **Human-Centric Conversation Sidebar & Multi-Field Fuzzy Search**:
  - Conversation list displays real titles as the primary label with message count and relative timestamps (`just now`, `5m ago`).
  - Search bar (`#pg-conv-search`) fuzzy-filters simultaneously across **title**, **workspace name**, and **session ID**.
- **Probabilistic Quantum Scoring Matrix & Telemetry Model Routing** (`docs/guide.md`):
  - Elevated `TextRouterMiddleware` model selection into a formalized state vector collapse model $|\Psi\rangle = \sum \alpha_i |M_i\rangle$ driven by provider health telemetry, task alignment weights, and context capacity thresholds.
- **Complete 14-Tool Reference Suite & Beginner Overview**:
  - Overhauled Dashboard Info (`ℹ️`) Modal with structured `🌟 Beginner Overview` + `🛠️ Subtools & Actions` guides.
  - Fully synchronized OSINT passive DNS recon action across docs, tool schemas, and dashboard surfaces.
- **`coding_agents` (OMP 5-Step Loop Architecture)** (`src/tools/coding-agents.ts`):
  - Implemented the official OMP (`omp.sh`) 5-step file modification lifecycle: `Enumerate` ➔ `Locate (RAG)` ➔ `Anchor ([PATH#TAG])` ➔ `Edit / ast_edit` ➔ `LSP / AST Diagnostics Verification`.
  - In-memory AST symbol extraction and TypeScript syntax diagnostic trapping (`parseDiagnostics`) to catch and reject syntax errors before disk mutations occur.
  - Added OMP `ast_edit` structural rewrite pattern matching (`ops=[{ pat, out }]`) and `resolve` (`apply`/`discard`) preview mechanics.
- **Pure Local TF-IDF `VectorStore` Semantic RAG** (`src/memory/VectorStore.ts`):
  - Lightweight token-bag TF-IDF vectorizer and cosine similarity ranking over workspace source code files with zero external API calls or token costs.
- **`local_llm_patch` MCP & Server Wiring** (`src/tools/local-llm-patch.ts`, `src/mcp/index.ts`, `src/server.ts`):
  - Registered `local_llm_patch` across stdio MCP tool definitions and added `POST /api/local_llm_patch` and `POST /api/tool` proxy support.
- **`cyber_tool` OSINT Reconnaissance Action** (`src/tools/cyber-tool.ts`):
  - Multi-record DNS reconnaissance (`A`, `AAAA`, `MX`, `TXT`, `NS`) via `node:dns/promises` alongside automated Google / CTF OSINT dork generation and Wiki report persistence.
- **Dashboard Per-Tool Info (`ⓘ`) Docs Viewer** (`src/server.ts`, `dashboard/app.js`):
  - Added `GET /api/tool-docs/:name` endpoint reading `docs/skill/references/*.md` and wired an inline documentation viewer directly on the dashboard tool playground header.
- **`coding_agents` Optimizations & Multi-Language LSP Validation** (`src/tools/coding-agents.ts`):
  - **Multi-Language Subprocess LSP Trapping**: Added proactive syntax verification for Python (`python -c "import ast; ..."`), Go (`go vet`), and Rust (`rustc --edition 2021 --error-format json`) in addition to TypeScript/JavaScript diagnostics, rejecting syntax-breaking edits before writing to disk.
  - **Sliding Window Chunking & Context Management**: Replaced crude line-based file truncation with token/block sliding windowing with rolling overlap, preserving call sites, imports, and interface anchors across context shifts.
  - **OMP Regex & Ast-Edit Robustness**: Hardened pattern regex matching against double-escaped metacharacters and prevented directory path traversal across staged patch scopes.
- **`quantum_tool` Reasoning Feedback Loop & Hallucination Drift Guard** (`src/tools/quantum-tool.ts`):
  - **Semantic Hallucination/Drift Guard (`computePromptDrift`)**: Evaluates Jaccard token similarity between the user's initial prompt and the synthesized LLM output; detects prompt divergence with an optional `autoCollapseOnDrift` flag that triggers quantum decoherence (collapses confidence to 0 and logs decoherence evidence).
  - **Adaptive Gate Recommendation Engine (`generateAdaptiveGateSuggestions`)**: Continuously analyzes cross-branch stance agreement/conflict matrix to recommend optimal circuit actions (e.g. `CNOT` entanglement on consensus, `RY` phase rotations on adversarial divergence, Grover-style confidence amplification on unresolved ~0.50 branches).
  - **Target-Anchored Sliding Window Evidence**: Compresses branch evidence history with sliding windows (retaining the 4 most recent assertions while collapsing older steps), preventing prompt bloat and context degradation during iterative reasoning loops.
  - **Bounded LRU Circuit Cache**: Replaced unbounded module-level state `Map` with an LRU cache (capped at 200 sessions, 2-hour TTL) to guarantee leak-free memory characteristics under heavy multi-agent concurrency.
- **Upstream Catalog Sync & Deprecation Harmonization**:
  - Deprecated Cerebras and updated live model metadata across NVIDIA NIM, Groq, Kilo Code, and OpenRouter.

---

## v1.0.9 – Search Router, Cyber Tool Graph, Hermes Skills, Quantum Reasoning, Local LLM Patch & Browser Snapshot Diff (July 2026)

### 🚀 Highlights

- **`SearchRouterMiddleware`** (`src/pipeline/middlewares/SearchRouterMiddleware.ts`): search-classified `use_free_llm` tasks now fall back through Parallel AI → Tavily → Jina → Brave → SearXNG (self-hosted, terminal fallback) instead of routing search through a general chat model. Each provider (`src/search/providers/*.ts`) implements the existing `BaseProvider` circuit-breaker (429 → flat cooldown, 5xx → exponential backoff), normalized into a shared `UnifiedSearchResult[]`. Every query is logged (fire-and-forget) to a new Firestore `search_logs` collection via `logSearchQuery` (`src/utils/firebase.ts`) and rendered on the dashboard's Providers tab — full result lists (not truncated previews) behind a `<details>` dropdown per query, mirroring the existing subtask-context dropdown pattern.
- **`cyber_tool` task-graph visualization**: `GET /api/cyber_tool/task_graph/:sessionId` (`src/server.ts`) surfaces the CTF decision graph (`goal/hypothesis/action/finding/deadend` nodes) that `save_graph`/`load_graph` already persisted — no new graph format, purely a dashboard rendering gap closed. Rendered in the Wiki tab, grouped into columns by `ctfType`.
- **Hermes Skills integration**: `external/hermes/` bundles 36 real skills fetched once from `github.com/nousresearch/hermes-agent` (`scripts/fetch-hermes-skills.ts`, one-time bootstrap — committed to the repo, never fetched at request time). `execute_skill`/`load_skill_prompt` auto-detect Hermes skills alongside the existing workspace/global `agentic-awesome` skills (`source: 'hermes' | 'agentic-awesome'`), injecting an adapter note that steers the model toward this server's own tools instead of raw filesystem operations a Hermes skill might assume.
- **`quantum_tool`** (new): a multi-branch/persona HITL reasoning aid using quantum-circuit vocabulary as a metaphor — branch "confidence" is grounded in real single-qubit rotation math (`RY`/`RZ` recover and reapply `phi = 2*asin(sqrt(confidence))`; `Z`/`RZ` are correctly no-ops on measurement probability, not simplifications), with an `analyze` action that calls a real LLM to synthesize across branches. See [`references/quantum_tool.md`](docs/skill/references/quantum_tool.md).
- **`local_llm_patch`** (new, standalone — not yet wired into MCP/server): a single-file patch stub against a genuinely local Ollama server (`src/providers/ollama-local.ts`, `http://localhost:11434`, no auth). Candidate models are *ranked* by coding-oriented naming, never *filtered* by name — whether a model can actually serve `/api/chat` (as opposed to being embedding-only) is only knowable by trying it for real, so the tool tries ranked candidates in order and treats a real API failure as the only valid signal to fall through to the next one. See [`references/local_llm_patch.md`](docs/skill/references/local_llm_patch.md) for the full non-goals list (no multi-file patches, no dataflow analysis, no `repo_graph.json` semantic RAG, no auto-apply — all deferred to v1.1.0's full `coding_agents`).
- **Browser snapshot structural diff**: `src/browser/SnapshotDiffer.ts` parses `take_snapshot`'s flat accessibility-tree text into an id-keyed node list and diffs two snapshots the same way `src/memory/graph-diff.ts` diffs repo graphs. `click` now attaches a `domDiffSummary` (e.g. `"+22 nodes mounted under \"Lineups\""`) whenever the DOM changed; `wait until:'dom-stable'` emits one summary diff on exit without adding cost to its 300ms polling loop. `BlockDetector` gained a second, structural interstitial signal (a near-total top-level wipeout replaced by a small added set) alongside its existing text-marker scan. `DomStateFingerprinter`, previously duplicated between `BrowserSession.ts` and `browser-action.ts`, is now defined once.
- **Firebase identity-churn fix**: `exchangeRefreshToken()` had no retry logic and silently minted a brand-new anonymous account on any transient network failure during token refresh. It now retries with backoff (matching the pattern already used by `getUserStats()`/`getLeaderboard()`), logs the real HTTP rejection reason, and warns explicitly when falling through to a new account despite having saved credentials.
- **`docs/` reference refactor**: `references/usages.md` split into one `.md` file per tool (`references/use_free_llm.md`, `references/browser_tool.md`, `references/cyber_tool.md`, `references/quantum_tool.md`, `references/local_llm_patch.md`, etc.), linked individually from `SKILL.md` so the skill doc stays focused on agentic workflow guidance rather than a growing test matrix.
- `empero-ai/Qwythos-9B-Claude-Mythos-5-1M` confirmed present in the HuggingFace provider list and reachable via `TextRouterMiddleware` routing (verify-only, no code change needed).

---

## v1.0.8 – Dynamic Intelligent Browser Scraper, Cyber Tool Registry, File-Lock Concurrency & Flat Schema Exports (July 2026)

### 🚀 Highlights

- **100% Dynamic Browser Scraper (`browser_tool`)**:
  - Implemented domain-agnostic `DynamicNodeAnalyzer` to discover interactive ARIA buttons and category tabs with zero hardcoded class strings.
  - Added quantified scroll depth observation (`0%` to `100%` bottom fold) and state monitoring.
  - Created `ScrapingSessionCheckpointManager` allowing users to pause, inspect frontend findings, select depth options, and resume sessions across process restarts.
  - Created `ScriptPersistenceManager` to save generated JS extraction functions to `data/scrapes/scripts/` for 0-token LLM context cost on subsequent runs.
  - Implemented `UniversalTabularSchemaFlattener` to dynamically flatten deeply nested JSON graphs into flat CSV rows (`startX`, `startY`, `endX`, `endY`, `outcome`).

- **`browser_tool` now owns a real browser session end to end.** The scaffolding above wasn't actually reachable: `scrapeAndProcessWithCheckpoint` was always invoked with `devtoolsEvalResponse: null` and no `mcpClient` from both `src/mcp/index.ts` and `POST /api/browser_tool`, so the tool silently exported zero records while reporting `success: true`. `src/browser/BrowserSessionPool.ts` now spawns and reuses a `chrome-devtools-mcp` session per `sessionId`, with LRU eviction, an idle reaper, and a cached-failure path so a broken engine returns a structured error instead of throwing or retrying a slow `npx` spawn on every call.
- **New action surface** (`src/browser/actionSchemas.ts`, `src/browser/dispatch.ts`): `navigate, snapshot, click, scroll, wait, evaluate, network, api_replay, extract, deep_scrape, screenshot, checkpoint, session`. One zod registry now generates both the MCP `inputSchema` and the runtime validation, closing the drift where `domainContext`/`filenameBase`/`deepScrapeLimit`/etc existed on `BrowserScrapeInput` but were never reachable over MCP. `action: 'scrape'` and `action: 'list_checkpoints'` remain supported as back-compat aliases.
- **Network body capture + private-API replay**: an injected fetch/XHR interceptor (`src/browser/interceptor.ts`) captures response bodies chrome-devtools-mcp's own `list_network_requests` doesn't expose, and `EndpointRanker`/`EndpointTemplater` (`src/browser/EndpointRanker.ts`, `EndpointTemplater.ts`) score discovered endpoints and mine id values from observed traffic/DOM instead of requiring them to be hardcoded.
- **Strict mode by default**: `interpretExtractedDataWithLLM` in `src/tools/browser-action.ts` no longer synthesizes plausible-looking `{id, title, link}` records when the LLM's output fails to parse — it now retries once with a corrective prompt, then reports `status: 'failed'` with a structured error. `success: true` with zero records is no longer possible without an explicit evidenced-empty-page warning.
- **Cloudflare/CAPTCHA block detection + Firebase logging**: `src/browser/BlockDetector.ts` scans snapshot text for known Cloudflare-interstitial and CAPTCHA markers on every `snapshot()` call. When a scrape action (`extract`, `api_replay`, `click`) fails on a page that's actually a challenge wall, the result now says so explicitly (`BLOCKED_BY_CLOUDFLARE` / `BLOCKED_BY_CAPTCHA`) instead of reporting a generic empty result, and the obstruction is fire-and-forget logged to a new `scraping_failures` Firestore collection via `logScrapingFailure` (`src/utils/firebase.ts`) — separate from the general `errors` collection so these are filterable on the dashboard.

- **Isolated Cyber Security Tool Registry (`cyber_tool`)**:
  - Created process-safe `CyberToolsRegistry` storing security binary mappings in userprofile path `~/.free-llm-mcp/cyber-tools-registry.json`.
  - Enforced atomic file-locking (`.lock`) synchronization to prevent multi-agent race conditions during concurrent tool registration.
  - Isolated security tool command flags and WAF/IPS troubleshooting logs within the dedicated `global-cyber-tools` wiki namespace.

- **Granular Step Logging & Web Dashboard Integration**:
  - Integrated Phase 3 `ChatLogger.logToolCall` across every step of `browser_tool` (`explore_surface_area`, `discover_nodes`, `click_node`, `save_checkpoint`, `load_checkpoint`, `list_checkpoints`, `scrape_and_process`) and `cyber_tool` (`list_tools`, `get_tool`, `register_tool`, `wiki_lookup`).
  - Added `browser_tool` and `cyber_tool` to `src/server.ts` express endpoints (`POST /api/browser_tool`, `POST /api/cyber_tool`), interactive Tool Playground dropdowns, and Quick Start accordions on the Web Dashboard.

- **Unit & Integration Testing Hardening**:
  - Achieved 100% green test status across 16/16 unit test suites (`npx vitest run`).
