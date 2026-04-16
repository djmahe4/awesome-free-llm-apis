---
name: free-llms
description: "Orchestrate multiple free LLM providers, manage persistent workspace memory, execute sandboxed code for context compression, and utilize keyword-based steering for project-specific reference extraction."
metadata:
  category: utility
  triggers: free models, llm cost, fallback, routing, token tracking, workspace memory, context-aware steering, reference extractor, keyword classification, project discovery, gemini, groq, cohere, cloudflare, deepseek, qwen, code mode, compression, sandbox
---

# Free LLM APIs — Agentic Skill

Discipline for orchestrating multiple free LLM providers via the `@mcp:free-llm-apis` MCP server.

> **79 models** across **15 providers** — optimized for FREE-first routing.

---

## 🎯 When to Use

- **Cost-Effective Inference**: When a task can be solved using free frontier or mid-tier models instead of paid APIs.
- **Resilient Workflows**: When a project requires automatic fallback cascading to ensure completion even during provider rate limits.
- **Stateful Context**: When an agent needs to persist findings or decisions across multiple turns or separate coding sessions.
- **Large Context Management**: When raw data (API responses, documentation) exceeds context limits and requires sandboxed pre-processing/compression via `code_mode`.
- **Architectural Steering**: When a task needs project-specific documentation or architectural maps to guide implementation.

## 🚫 When NOT to Use

- **Privacy-Sensitive Data**: When data cannot be sent to third-party free providers (verify specific provider terms of service if unsure).
- **Hard Real-Time Constraints**: When sub-second response times of paid tiers are strictly required (though Cloudflare/Groq are extremely fast).
- **Non-Coding Mathematical Logic**: Avoid letting the LLM perform complex math directly; use the `code_mode` tool instead.

---

## ⚡ Quick Routing Reference

| Use Case | Model | Provider | Notes |
|----------|-------|----------|-------|
| Fast Chat (FREE) | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | `cloudflare` | 100% success, 1307ms avg ⚡ |
| Fast Coding (FREE) | `@cf/qwen/qwq-32b` | `cloudflare` | Reasoning-focused, FREE ⚡ |
| Complex Reasoning | `command-a-03-2025` | `cohere` | Long-form, accurate |
| Code Generation | `qwen2.5-coder-32b-instruct` | `llm7` | Verified LRU/async patterns |
| Deep Reasoning / CoT | `deepseek-r1` | `llm7` / `kluster` | Chain-of-thought |
| Creative / Persona | `gemini-2.5-flash` | `gemini` | Large context, verified E2E |
| Budget / High-Volume | `Qwen/Qwen2.5-7B-Instruct` | `siliconflow` | 1,000 rpm |
| Latest Frontier | `gemini-3.1-pro-preview` | `gemini` | Highest capability |

> **FREE-First Strategy**: Cloudflare models are now prioritized for fastest, most reliable responses. Router automatically cascades through 79 models across all 15 providers.

---

## 🛠️ Tool Reference

### `use_free_llm`

Perform a chat completion with optional fallback and workspace memory.

> [!IMPORTANT]
> **PROJECT WORK RULE**: For any task within a project/workspace, you MUST set `"agentic": true` AND provide `"workspace_root"`. Without these, the request is "context-blind" (no session memory, no project-specific prompts).

**Project Task Example (Mandatory):**
```json
{
  "messages": [{ "role": "user", "content": "Implement the auth logic in auth.ts" }],
  "agentic": true,
  "workspace_root": "c:/Users/mahes/OneDrive/Desktop/Python-Projects/my-app"
}
```

**One-off Query Example:**
```json
{
  "messages": [{ "role": "user", "content": "Explain what a JWT is" }]
}
```

**Key parameters:**

| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `messages` | yes | — | Array of `{ role, content }` objects |
| `model` | no | auto | Specific model ID. If omitted, the router auto-selects. |
| `keywords` | no | — | Explicit steering keywords. **Bypasses fuzzy matching** and injects only sections matching these tags. |
| `agentic` | no | `false` | Enable agentic mode: task decomposition and internal prompt injection. **Mandatory for project work.** |
| `workspace_root` | no | — | Path for context-aware cache keying. **Mandatory for project work.** |
| `sessionId` | no | — | Optional. If omitted, it's auto-derived from `workspace_root`. |
| `google_search` | no | `false` | Enable Google search for Gemini models. |

> **Rule:** Always set `fallback: true` when building resilient pipelines.

---

### `validate_provider`

Run a live health check + credential validation for a specific provider.

```json
{ "providerId": "groq" }
```

**Verified Providers (as of 2026-03-29):** `groq` ✅, `gemini` ✅, `cohere` ✅
**Not Tested:** `github-models` (requires GitHub Models API key)

---

### `get_token_stats`

Retrieve live token consumption and rate limit status per provider.

```json
{}
```

Returns an array of 15 provider stat objects including `rateLimits`, `remainingTokens`, and `refreshTime` for each provider tracked by the router.

> **Note:** Token tracking is now handled by the router's internal LLMExecutor. Stats reflect actual rate limit state from recent API calls.

> Run after each session to check quota consumption and rate limit status.

---

### `list_available_free_models`

Enumerate all registered models with availability, rate limits, and provider metadata.

```json
{ "available_only": true }
```

> Filters to only providers with valid API keys configured.

---

### `code_mode`

Execute sandboxed code against arbitrary data. Only `stdout` is returned — never the raw `DATA` payload. Use this to compress large API responses before passing to an LLM.

```json
{
  "language": "javascript",
  "command": "Sort input numbers",
  "data": "[5, 2, 8, 1]",
  "code": "const arr = JSON.parse(DATA); arr.sort((a,b)=>a-b); print(JSON.stringify(arr));"
}
```

**Supported Languages:**

| `language` | Sandbox | Notes |
|------------|---------|-------|
| `javascript` (default) | QuickJS (quickjs-emscripten) | Fastest; no external deps |
| `python` | Restricted subprocess | Requires Python 3 + pip install RestrictedPython |
| `go` | goja | pure-Go ECMAScript; requires pre-built binary |
| `rust` | boa_engine | pure-Rust ECMAScript; requires pre-built binary |

**Key parameters:**

| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `code` | yes | — | Script source; use `print()` / `console.log()` for output |
| `language` | no | `javascript` | Sandbox runtime: `javascript` \| `python` |
| `data` | no | `""` | Injected as `DATA` global variable |
| `command` | no | — | Human-readable description (logged to memory) |
| `timeout_ms` | no | `5000` | Max execution time in milliseconds |

**Sandbox Constraints (all languages):** No filesystem, no network, no process/OS calls.

> **Context Compression**: `compressionRatio` = stdout.length / data.length — a ratio < 1 means context savings were achieved. See [code-mode-logic.md](references/code-mode-logic.md) for advanced patterns and benchmarks, and TC-05 in [usages.md](references/usages.md) for execution results.

---

### `manage_memory`

Manage persistent, workspace-aware memory across sessions.

```json
{ "action": "search", "query": "previous analysis", "workspace_root": "/your/project" }
```

| Action | Description |
|--------|-------------|
| `search` | Full-text search over stored memory |
| `list` | Get workspace hash for integrity checking |
| `stats` | Check compression ratios per cached tool |
| `clear` | Flush all cached memory for the workspace |

> **Rule:** Always `search` memory before starting any new research task.
> **Documentation:** See [memory-usage.md](references/memory-usage.md) for architectural details and search optimization.

---

### `store_memory`

Store manual context or persistent thoughts into the long-term workspace memory.

```json
{
  "key": "auth_strategy",
  "content": "We decided to use Redis for caching sessions to improve latency.",
  "workspace_root": "/your/project"
}
```

> **Rule: Always `store_memory` upon task completion.** Explicitly save findings, decisions, or summaries after concluding research or a large task. This ensures instant recall via `manage_memory (search)` in future sessions, preventing knowledge loss.
> **Documentation:** See [memory-usage.md](references/memory-usage.md) for versioning and schema patterns.

---

## 🦾 Keyword-Based Task Classification

The Intelligent Router and Steering Engine utilize specific keywords in the goal or plan to classify tasks and select relevant reference materials.

### 🎯 Core Trigger Keywords

| Category | Keywords | Impact |
|----------|----------|--------|
| **API/REST** | `api`, `endpoint`, `url`, `rest`, `status code`, `json` | Prioritizes API documentation and schema references |
| **Persistence** | `database`, `sql`, `memory`, `cache`, `persistence`, `redis` | Prioritizes database schemas and memory-state patterns |
| **Security** | `auth`, `jwt`, `token`, `security`, `encryption`, `cors` | Prioritizes authentication protocols and security guidelines |
| **DevOps** | `git`, `env`, `deploy`, `ci`, `docker`, `config` | Prioritizes environment configurations and CI/CD maps |
| **Research** | `search`, `research`, `findings`, `knowledge`, `discover` | Activates deep-search and memory-retrieval optimization |

---

## 🧠 Agentic Patterns

### Pattern 1: Subagent Bootstrap with Memory

```
1. manage_memory search  →  found prior plan?
   - Yes: use as context for current task
   - No: generate plan via use_free_llm, save output to file
2. list  →  verify workspace hash matches expected state
3. Execute subagent with plan as system context
```

### Pattern 2: Evolving Research Pipeline

```
[Search memory] → found? → [Augment existing insight] → [Generate next hypothesis]
               → empty? → [Seed with first LLM call]  → [Save findings]
```

Each iteration builds on the last. Use `code_mode` to compress and deduplicate findings.

### Pattern 3: Self-Evolving Instruction Loop

1. **Run** task using current instructions from memory
2. **Evaluate** output via second LLM call — use `cohere` for critique
3. **Rewrite** instructions if quality < threshold
4. **Store** improved instructions with a timestamp key

### Pattern 4: Terminal Task Completion (The Handshake)

```
1. finalize_task  →  Generate final summary/artifact
2. store_memory   →  Save summary + decisions to "completion/<task_id>"
3. manage_memory  →  Verify storage success
4. [DONE]         →  Inform user and exit
```
Always conclude significant work by "checking in" your knowledge to the workspace memory.

---

## 🔴 Anti-Rationalization Rules

- **DO NOT** use `use_free_llm` for project work without `agentic: true` and `workspace_root`.
- **DO NOT** start a pipeline without checking memory for prior findings first.
- **DO NOT** conclude a task or session without saving findings via `store_memory`.
- **DO NOT** skip `validate_provider` if a provider fails two consecutive calls.
- **DO NOT** accumulate raw LLM outputs — compress and deduplicate via `code_mode`.
- **ALWAYS** version subagent instruction changes with a timestamp key.
- **ALWAYS** set `fallback: true` for critical or user-facing pipelines.
- **ALWAYS** pass the correct absolute `workspace_root` for project tasks — the pipeline derives its grounding signals from this path.

---

## 🛡️ Internal Grounding & Attestation Protocol (v1.0.4)

> [!NOTE]
> This section describes **pipeline-internal** behavior. These mechanisms are automatically enforced by the server and are **not** responsibilities of the calling agent.

The pipeline injects a **Grounding Protocol** into the system prompt of every LLM it calls. This forces the model to tag its claims:
- **`[RETRIEVED]`** — fact is directly present in injected context blocks (e.g., resolved `file://` or `artifact://` URIs, session memory).
- **`[NOT FOUND]`** — the file or context is mentioned but its content was not found or resolved. The model MUST stop and ask the user to provide it.

### 🚪 Read-First Gate
Triggered automatically when `workspace_root` contains a `README.md`. The pipeline injects a mandatory instruction forcing the model to verify all assertions against the provided context blocks **before** proposing any architecture or implementation.

**Note on Tools**: The hosted LLM in the pipeline has NO direct tool-access to the filesystem. It relies entirely on the server's automated URI resolution and context injection. If it needs more data, it must ask the caller.

**What the calling agent must do:** Simply provide an accurate `workspace_root` and ensure files are mentioned using `file:///` URIs. The gate fires automatically.

---

## 🤖 Agentic Middleware v2 (Steering Engine)

The server features a **Context-Aware Steering Engine** that manages stateful task execution via the `use_free_llm` tool. It transforms static documentation into a dynamic, token-efficient prompt pipeline.

### ⚡ AI-First Triggering

Dynamically activate the agentic loop by passing the `agentic` and `sessionId` parameters when calling `use_free_llm`. This is the preferred method for managing complex, multi-turn coding tasks.

### 🧠 Intelligent Behaviors

- **Semantic Prompt Resolution**: Automatically indexes relevant prompt sections. A **stricter selection threshold (score >= 3)** ensures instructions are mission-critical, eliminating "context noise."
- **Granular Reference Extraction**: The steering engine parses massive architectural maps and extracts only relevant project entries. Extracted entries are **capped at 5 per section** to maintain a lean context window.
- **Stateful Project Memory**: Passing a `sessionId` persists task state (`nowQueue`, `improveQueue`) and project logs (`plan.md`, `tasks.md`, `knowledge.md`) in `projects/{sessionId}/`.
- **Automatic Task Decomposition**: Automatically splits complex goals into discrete, trackable steps.

### ⚡ Reference Steering Protocols

When architectural keywords are detected, the system injects a **Reference Suggestion Protocol**. Follow this format when suggesting project-specific URLs:

> **Protocol Format:** `[Project Name] (Reference: <URL>) - <Description>`

### 🧐 Observability & Grounding

The middleware implements **Research Validation Logging** to ensure all agentic actions are grounded in verified data:
- **[RESEARCH-VALIDATION]** logs fire during pre-execution (detection) and post-execution (grounding check).
- Provides an explicit audit trail for external knowledge lookups and architectural steering.

---

### 🛠️ Strategic Usage Patterns

- **Activation**: Set `agentic: true` and provide `workspace_root` for **ALL** project-related tasks. This ensures the agent has access to prior decisions, planned tasks, and project-specific guidelines. For simple, context-free queries (e.g., "how does X work?"), leave these out to optimize latency.
- **Session Consistency**: The `sessionId` is typically auto-derived from your `workspace_root`. If you need to switch between multiple sub-tasks within the same workspace, you can provide an explicit `sessionId`.
- **Explicit Steering**: Pass a `keywords` array to strictly control the injected system prompt AND the task routing tier. This documentation-first approach bypasses fuzzy logic, ensuring the agent receives ONLY relevant reference material and is routed to the optimal model tier (e.g., Coding vs. Research) via majority-voting, saving thousands of tokens.
- **Architectural Discovery**: Instead of requesting the "whole map," request "references for [System X]". The booster will identify the relevant entries and provide deep links without exceeding the token budget.

> [!NOTE]
> The source of truth for behavior is controlled by the `external/agent-prompt/README.md`. IRRELEVANT instructions are filtered out automatically.

See [usages.md](references/usages.md) for the full test matrix with actual responses, token counts, and latency measurements for all tools.
