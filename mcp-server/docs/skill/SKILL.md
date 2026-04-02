---
name: free-llms
description: "Use when performing tasks that require free LLM inference, model fallback routing, persistent workspace memory, evolving research pipelines, or subagent script generation."
metadata:
  category: utility
  triggers: free models, llm cost, fallback reasoning, token usage, workspace memory, subagent, research pipeline, evolving agent, learning loop, gemini, groq, cohere, code mode, sandbox, arch map, subsystem ref, token-safe, granular extraction, steering protocol, api map
---

# Free LLM APIs — Agentic Skill

Discipline for orchestrating multiple free LLM providers via the `@mcp:free-llm-apis` MCP server.

> **79 models** across **15 providers** — optimized for FREE-first routing.

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

Send a chat completion with optional fallback and workspace memory.

```json
{
  "model": "llama-3.3-70b-versatile",
  "messages": [{ "role": "user", "content": "Your prompt here" }],
  "provider": "groq",
  "fallback": true,
  "max_tokens": 1024,
  "workspace_root": "/your/project"
}
```

**Key parameters:**

| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `model` | ✅ | — | Model ID from `list_available_free_models` |
| `messages` | ✅ | — | Array of `{ role, content }` objects |
| `provider` | ❌ | auto | Override auto-routing to a specific provider |
| `fallback` | ❌ | `false` | Enable cross-provider failover |
| `max_tokens` | ❌ | 1024 | Cap response size |
| `workspace_root` | ❌ | — | Path for context-aware cache keying |

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

Execute sandboxed JavaScript against arbitrary data. `DATA` is injected as a string.

```json
{
  "command": "Sort input numbers",
  "data": "[5, 2, 8, 1]",
  "code": "const arr = JSON.parse(DATA); arr.sort((a,b)=>a-b); print(JSON.stringify(arr));"
}
```

- Execution timeout: **5000ms** (configurable via `timeout_ms`)
- Use `print()` to output results
- No filesystem or network access from within the sandbox

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

---

## 🔴 Anti-Rationalization Rules

- **DO NOT** start a pipeline without checking memory for prior findings first
- **DO NOT** skip `validate_provider` if a provider fails two consecutive calls
- **DO NOT** accumulate raw LLM outputs — compress and deduplicate via `code_mode`
- **ALWAYS** version subagent instruction changes with a timestamp key
- **ALWAYS** set `fallback: true` for critical or user-facing pipelines

---

## 🤖 Agentic Middleware v2 (High-Performance Steering)

The server features a **Context-Aware Steering Engine** that manages high-performance, stateful task execution via the `use_free_llm` tool. It transforms static documentation into a dynamic, token-efficient prompt pipeline.

### ⚡ AI-First Triggering

You can dynamically "activate" your own agentic loop by passing the `agentic` and `sessionId` parameters when calling `use_free_llm`. This is the preferred way to manage complex, multi-turn coding tasks.

```json
{
  "model": "gpt-4o",
  "messages": [...],
  "agentic": true,
  "sessionId": "project-name-v1"
}
```

### 🧠 Intelligent Behaviours

- **Semantic Prompt Resolution**: Automatically indexes `external/agent-prompt/README.md` and scores sections based on your request context. You receive only the most relevant instructions (e.g., "MOMENTUM ENGINE" for performance tasks), maximizing focus and token efficiency.
- **Granular Reference Extraction**: The steering engine can parse massive architectural maps (e.g., "Research Appendix") and extract only the relevant project entries. It uses a regex-based splitter (`/\n(?=- \[)/`) and scores each entry individually, reducing context bloat by up to 90%.
- **Stateful Project Memory**: Passing a `sessionId` persists your task state (`nowQueue`, `improveQueue`) and project logs (`plan.md`, `tasks.md`, `knowledge.md`) in `projects/{sessionId}/`. This enables consistent cross-turn reasoning.
- **Automatic Task Decomposition**: The middleware automatically splits your user goal into discrete steps and monitors progress. It fits auxiliary instructions within a strict budget (default: 25,000 chars) to prevent "context rot."

### ⚡ Reference Steering Protocols

When the middleware detects architectural keywords, it injects a **Reference Suggestion Protocol**. You MUST follow this format when suggesting project-specific URLs:

> **Protocol Format:** `[Project Name] (Reference: <URL>) - <Description>`

#### 🚀 Keyword Boosters
The scoring engine prioritizes reference sections when these keywords appear in your goal or plan:
- `api`, `url`, `git`, `map`, `rest`, `endpoint`, `reference`

### 🛠️ Strategic Usage Patterns

- **Activation Requirement**: Only set `agentic: true` for complex architectural changes or long-running feature developments. For simple one-off queries, leave it `false` to optimize latency.
- **Session Consistency**: Use a unique, descriptive `sessionId` (e.g., `auth-refactor-2024`) per project to ensure your memory remains isolated from other tasks.
- **Steering with Keywords**: If you need specific rules (e.g., "SQL Best Practices"), include those keywords in your request. The engine will resolve the matching semantic sections from the master prompt.
- **Architectural Discovery**: Instead of asking for the "whole map," ask for "references for [System X]". The booster will identify the relevant entries and provide deep links without exceeding the token budget.

> [!NOTE]
> The source of truth for your behavior is controlled by the `external/agent-prompt/README.md`. The pipeline ensures you never receive irrelevant instructions.

See [usages.md](references/usages.md) for the full test matrix with actual responses, token counts, and latency measurements for all 6 tools across real providers.
