---
name: free-llm-apis
description: "Use when performing tasks that require free LLM inference, model fallback routing, persistent workspace memory, evolving research pipelines, or subagent script generation."
metadata:
  category: utility
  triggers: free models, llm cost, fallback reasoning, token usage, workspace memory, subagent, research pipeline, evolving agent, learning loop, gemini, groq, cohere, code mode, sandbox
---

# Free LLM APIs — Agentic Skill

Discipline for orchestrating multiple free LLM providers via the `@mcp:free-llm-apis` MCP server.

> **62 models** across **15 providers** — 59 verified active.

---

## ⚡ Quick Routing Reference

| Use Case | Model | Provider | Notes |
|----------|-------|----------|-------|
| Fast Q&A | `llama-3.3-70b-versatile` | `groq` | ~34ms, verified |
| Complex Reasoning | `command-a-03-2025` | `cohere` | Long-form, accurate |
| Code Generation | `qwen2.5-coder-32b-instruct` | `llm7` | Verified LRU/async patterns |
| Deep Reasoning / CoT | `deepseek-r1` | `llm7` / `kluster` | Chain-of-thought |
| Creative / Persona | `gemini-2.5-flash` | `gemini` | Large context, verified E2E |
| Budget / High-Volume | `Qwen/Qwen2.5-7B-Instruct` | `siliconflow` | 1,000 rpm |
| Latest Frontier | `gemini-3.1-pro-preview` | `gemini` | Highest capability |

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

Retrieve live token consumption and request counts per provider.

```json
{}
```

Returns an array of 15 provider stat objects including `rateLimits`, `usage.tokens`, and `usage.requests`.

> Run after each session to check quota consumption.

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

## 🧪 Verified Test Results

See [usages.md](../usages.md) for the full test matrix with actual responses, token counts, and latency measurements for all 6 tools across real providers.
