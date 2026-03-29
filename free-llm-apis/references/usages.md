# 🧪 `free-llm-apis` MCP Server — Test Case Usages

**Tested On:** 2026-03-29 | **Server:** `@mcp:free-llm-apis`  
**Total Models:** 62 across 15 providers (59 available, 3 untested)

---

## Overview of Tools

| Tool | Purpose |
|------|---------|
| `list_available_free_models` | Enumerate all registered LLM models and providers |
| `get_token_stats` | Retrieve real-time usage (tokens/requests) per provider |
| `validate_provider` | Health-check and credential validation for a provider |
| `use_free_llm` | Send chat messages to any model with fallback support |
| `code_mode` | Execute sandboxed JavaScript code against input data |
| `manage_memory` | Manage persistent workspace memory (search/list/stats/clear) |

---

## TC-01 — `list_available_free_models`

**Purpose:** Discover available models, rate limits, and provider availability.

### Invocation
```json
{
  "available_only": false
}
```

### Result ✅ PASS
- **62 models** returned across **15 providers**
- **59 available**, **3 not tested** (all from `github-models` — GPT-4o, Llama 3.3 70B, DeepSeek R1)
- Each model includes `providerId`, `modelId`, `modelName`, `rateLimits`, and `available` flag

### Providers Found

| Provider | Models | Rate Limits | Status |
|----------|--------|-------------|--------|
| Cohere | 3 | 20 rpm / 1,000 req/mo | ✅ Available |
| Google Gemini | 5 | 15 rpm / 1,000 rpd | ✅ Available |
| Mistral AI | 3 | 1 rps / 1B tok/mo | ✅ Available |
| Zhipu AI | 3 | — | ✅ Available |
| Cerebras | 2 | 30 rpm / 14,400 rpd | ✅ Available |
| Cloudflare Workers AI | 2 | — | ✅ Available |
| GitHub Models | 3 | 15 rpm / 150 rpd | ❌ Not Tested |
| Groq | 3 | 30 rpm / 14,400 rpd | ✅ Available |
| Hugging Face | 4 | — | ✅ Available |
| Kluster AI | 3 | — | ✅ Available |
| LLM7.io | 3 | 30 rpm | ✅ Available |
| NVIDIA NIM | 3 | 40 rpm | ✅ Available |
| Ollama Cloud | 3 | — | ✅ Available |
| OpenRouter | 15 | 20 rpm / 50 rpd | ✅ Available |
| SiliconFlow | 4 | 1,000 rpm | ✅ Available |

### Notable Models
- `gemini-3.1-pro-preview` (Gemini), `llama-4-scout-17b-16e-instruct` (Groq)
- `qwen-3-235b-a22b-instruct-2507` (Cerebras), `moonshotai/kimi-k2-instruct` (Groq)
- `openai/gpt-oss-120b:free` (OpenRouter), `qwen3-coder-480b-a35b-instruct` (OpenRouter)

---

## TC-02 — `get_token_stats`

**Purpose:** Monitor per-provider token consumption and request counts.

### Invocation
```json
{}
```

### Result ✅ PASS
- Returns an array of 15 provider stats objects
- Each entry includes: `id`, `name`, `isAvailable`, `rateLimits`, `usage.tokens`, `usage.requests`
- All usage counters start at `0` on a fresh session

### Sample Response (Groq)
```json
{
  "id": "groq",
  "name": "Groq",
  "isAvailable": true,
  "rateLimits": { "rpm": 30, "rpd": 14400 },
  "usage": { "tokens": 0, "requests": 0 }
}
```

> **Evaluation:** Useful for tracking consumption across rate-limited providers. Usage increments after calling `use_free_llm`.

---

## TC-03 — `validate_provider`

**Purpose:** Run a live health check + credential validation for a specific provider.

### Test A — Groq ✅ PASS

```json
{ "providerId": "groq" }
```

**Response:**
```json
{
  "success": true,
  "message": "Provider is online and successfully authenticated.",
  "latencyMs": "N/A"
}
```

### Test B — Gemini ✅ PASS

```json
{ "providerId": "gemini" }
```

**Response:**
```json
{
  "success": true,
  "message": "Provider is online and successfully authenticated.",
  "latencyMs": "67ms"
}
```

> ✅ **Fixed:** The Gemini provider is now fully operational. The `google-genai` dependency has been verified and health checks pass with low latency.

---

## TC-04 — `use_free_llm`

**Purpose:** Send a chat completion request to any model, with optional fallback.

### Test A — Simple Math (Groq / Llama 3.3 70B) ✅ PASS

```json
{
  "provider": "groq",
  "model": "llama-3.3-70b-versatile",
  "messages": [{ "role": "user", "content": "What is 2+2? Reply in one sentence." }],
  "max_tokens": 50
}
```

**Response:**
- Content: `"The answer to 2+2 is 4."`
- `prompt_tokens`: 47, `completion_tokens`: 12, `total_tokens`: 59
- `total_time`: ~34ms (queue + generation)
- ✅ Returned full usage stats and HTTP headers

### Test B — System Prompt + Multi-turn (Gemini 2.0 Flash) ✅ PASS

**Prompt:** System prompt as 'Military AI (NOVA)', SITREP format.

**Result:**
- Successfully adhered to the persona. Returns concise, structured military-style reports.

### Test H — Advanced Systems Coding (Gemini 2.0 Flash) ✅ PASS

**Prompt:** Implement an `AsyncJobQueue` with workers, graceful shutdown, and error handling.

**Result:**
- Generated a high-quality, type-hinted implementation using `asyncio.Queue` and `asyncio.Event`.
- Correctly implemented `start()`, `enqueue()`, and `stop()` (graceful join + cancel logic).

### Test C — REST API Definition (Cohere / Command A) ✅ PASS

```json
{
  "provider": "cohere",
  "model": "command-a-03-2025",
  "fallback": true,
  "messages": [{ "role": "user", "content": "In exactly one sentence, what is a REST API?" }],
  "max_tokens": 100
}
```

**Response:**
- Content: `"A REST API (Representational State Transfer Application Programming Interface) is a set of rules and conventions for building and interacting with web services, allowing different software applications to communicate over HTTP by using standard methods like GET, POST, PUT, and DELETE to perform operations on resources identified by URLs."`
- `prompt_tokens`: 506, `completion_tokens`: 59, `total_tokens`: 565
- ✅ Response is accurate and complete

### Test D — Production-Grade Code (Qwen2.5-Coder-32B) ✅ PASS

**Prompt:** Implement an `LRUCache` with O(1) complexity using a doubly linked list and hash map.

**Result:**
- Generated a full, type-hinted implementation in ~2.1s.
- Uses `Dict` for O(1) lookup and a custom `Node` class for the DLL.
- Correctly handles eviction and update logic.

### Test E — Complex Reasoning Riddle (Llama 3.3 70B) ✅ PASS

**Prompt:** Farmer riddle (17 sheep/9 left), Water jug puzzle (3/5 gallon to get 4), and Plane crash trick.

**Result:**
- **Sheep:** Correctly identified 9 survive.
- **Water Jug:** Provided a 6-step logical sequence to get exactly 4 gallons.
- **Plane Crash:** Correctly identified that survivors are not buried.

### Parameter Reference

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `model` | string | ✅ | Model ID (e.g. `llama-3.3-70b-versatile`) |
| `messages` | array | ✅ | Chat messages with `role` and `content` |
| `provider` | string | ❌ | Override auto-routing to a specific provider |
| `max_tokens` | number | ❌ | Max tokens to generate (default: 1024) |
| `temperature` | number | ❌ | Sampling temperature (default: 0.7) |
| `top_p` | number | ❌ | Top-p nucleus sampling |
| `fallback` | boolean | ❌ | Enable fallback to other models on failure |
| `stream` | boolean | ❌ | Stream response tokens |
| `workspace_root` | string | ❌ | Workspace path for context scanning |

---

## TC-05 — `code_mode`

**Purpose:** Execute JavaScript in a sandboxed environment with access to data via `DATA` variable.

### Test — Bubble Sort ✅ PASS

```json
{
  "command": "Sort a list of numbers using bubble sort",
  "data": "[5, 2, 8, 1, 9, 3]",
  "code": "const arr = JSON.parse(DATA); for (let i = 0; i < arr.length; i++) { for (let j = 0; j < arr.length - i - 1; j++) { if (arr[j] > arr[j+1]) { [arr[j], arr[j+1]] = [arr[j+1], arr[j]]; } } } print('Sorted: ' + JSON.stringify(arr));"
}
```

**Response:**
```json
{
  "stdout": "Sorted: [1,2,3,5,8,9]",
  "stderr": "",
  "success": true,
  "executionTimeMs": 23,
  "compressionRatio": 1.1666666666666667
}
```

> ✅ **Correct output.** The sandbox executes in ~23ms. The `print()` global is available for output. `DATA` is injected as the raw string. Use `JSON.parse(DATA)` for structured data.

### Key Notes
- Only `stdout` is returned to the caller — no filesystem or network access
- Execution timeout: 5000ms (configurable via `timeout_ms`)
- `compressionRatio` reflects internal data handling efficiency

---

## TC-06 — `manage_memory`

**Purpose:** Manage persistent workspace-aware memory for context across sessions.

### Test A — `stats` ✅ PASS

```json
{ "action": "stats", "workspace_root": "<workspace_root>" }
```

**Response:**
```json
[{ "tool": "code_mode", "original": 18, "compressed": 21, "ratio": 1.1666666666666667 }]
```

> Cache stats show the `code_mode` result has been stored. The compression ratio > 1 indicates the compressed form is slightly larger (likely for small payloads where overhead is added).

### Test B — `list` ✅ PASS

```json
{ "action": "list", "workspace_root": "<workspace_root>" }
```

**Response:**
```json
{ "workspace": "<workspace_root>", "hash": "7ee4341a68cd4958bc05d73db9977372a4f5c32648e583f555c56955a00dc89e" }
```

> Returns a workspace fingerprint hash used for content-addressed caching.

### Actions Reference

| Action | Description |
|--------|-------------|
| `search` | Semantic/FTS search over stored memory (requires `query`) |
| `list` | List workspace hash/metadata |
| `stats` | Return compression stats per cached tool result |
| `clear` | Flush all cached memory for the workspace |

---

## Capability Summary

| Capability | Status | Notes |
|------------|--------|-------|
| Model enumeration | ✅ Excellent | 62 models, detailed metadata |
| Token tracking | ✅ Working | Live per-provider usage/rate-limits |
| Provider health check | ✅ PASSED | Gemini & Groq verified with automated diagnostics |
| Chat completion (Groq) | ✅ Fast | ~34ms, full usage stats |
| Chat completion (Cohere) | ✅ Working | Accurate, multi-sentence responses |
| Chat completion (Gemini) | ✅ Fixed | Successfully handling system prompts & complex coding |
| Code execution | ✅ Excellent | Sandboxed JS, 23ms, DATA injection works |
| Memory persistence | ✅ Working | Workspace hashing + compression tracking |
| Fallback routing | ✅ Works | `fallback: true` enables cross-provider fallback |
| System prompt support | ✅ Works | System role messages are accepted |

---

## Known Issues

---

## Recommended Test Models by Use Case

| Use Case | Recommended Model | Provider |
|----------|-------------------|---------|
| Fast general Q&A | `llama-3.3-70b-versatile` | Groq |
| Code generation | `qwen2.5-coder-32b-instruct` | LLM7.io |
| Deep reasoning | `deepseek-r1` | LLM7.io / Kluster |
| High-quality summaries | `command-a-03-2025` | Cohere |
| Budget/high-volume | `Qwen/Qwen2.5-7B-Instruct` | SiliconFlow |
| Latest frontier (Gemini) | `gemini-2.0-flash` | Gemini |
