# INTAKE.md — Agent-Server Intake Protocol

> Live traces captured from **8 real `use_free_llm` calls** against the MCP server itself.
> Generated: 2026-04-05  |  Server: `free-llm-mcp-server@1.0.3`  |  66 models · 14 providers

---

## Overview

The intake protocol describes every path an agentic call can take through the server's pipeline:

```
Agent → use_free_llm() ─┬─ [keywords only]          → Majority-Voting → optimal tier
                        ├─ [model only]              → Pinned provider
                        ├─ [keywords + model]        → Pinned model, keyword-enriched prompt
                        └─ [bare minimum]            → Auto-route: first available provider
                                ↓
                    IntelligentRouterMiddleware
                                ↓
                    LLMExecutor (HTTPS → Provider)
                    ↓ writes providerRemainingTokens (if headers present)
                                ↓
                    ContextManager.compress() ← bridge override
                                ↓
                         Response to Agent
```

---

## Intake Patterns

### Pattern 1 — Bare Minimum (no keywords, no model)

**Inputs:** `messages` only — zero steering.  
**Routing:** Falls through to the first available provider.

```json
{
  "messages": [{ "role": "user", "content": "Name the capital of France." }]
}
```

**Live response:**

| Field | Value |
|-------|-------|
| Routed model | `codestral-latest` (LLM7.io) |
| Provider headers | No `x-ratelimit-*` _(no bridge signal)_ |
| Response | `"The capital of France is **Paris**."` |
| Latency | ~1 s |

> **Bridge**: No `providerRemainingTokens` written. ContextManager uses static estimate.

---

### Pattern 2 — Chat Keyword Auto-Routing

**Inputs:** `keywords: ["chat"]`, no model.  
**Routing:** Majority-voting classifies as `chat` → lightweight chat-tier model.

```json
{
  "messages": [{ "role": "user", "content": "In exactly 2 sentences: what is a middleware pipeline?" }],
  "keywords": ["chat"]
}
```

**Live response:**

| Field | Value |
|-------|-------|
| Routed model | `codestral-latest` (LLM7.io) |
| Provider headers | No `x-ratelimit-*` _(no bridge signal)_ |
| Response | 2-sentence definition of middleware pipeline |
| Latency | ~2 s |

**Exact Output**
```
A middleware pipeline is a sequence of middleware components that process HTTP requests and responses in a web application, allowing for modular and reusable functionality like authentication, logging, and error handling. Each middleware in the pipeline can inspect, modify, or short-circuit the request or response before passing it to the next middleware or the final handler.
```

---

### Pattern 3 — Coding Keyword Steering

**Inputs:** `keywords: ["coding", "typescript"]`, no model.  
**Routing:** Majority-voting → `coding` tier → code-specialized model.

```json
{
  "messages": [{ "role": "user", "content": "Write a TypeScript function that debounces an async function." }],
  "keywords": ["coding", "typescript"]
}
```

**Live response:**

| Field | Value |
|-------|-------|
| Routed model | `codestral-latest` (LLM7.io, code specialist) |
| Provider headers | No `x-ratelimit-*` |
| Output quality | Complete, generic-typed `debounceAsync<T>` with `pendingPromise` guard |
| Latency | ~2 s |

> **Note:** `codestral-latest` selected because it maps to the `coding` task tier in `keywordTaskMap`.

---

### Pattern 4 — Research Keyword Steering

**Inputs:** `keywords: ["research", "architecture"]`, no model.  
**Routing:** Majority-voting → `research` tier → broader reasoning model.

```json
{
  "messages": [{ "role": "user", "content": "In 3 bullet points, describe the key tradeoffs between REST and GraphQL." }],
  "keywords": ["research", "architecture"]
}
```

**Live response:**

| Field | Value |
|-------|-------|
| Routed model | `codestral-latest` (LLM7.io) |
| Output | 3 structured bullets: Flexibility, Performance, Client Control |
| Latency | ~2 s |

---

### Pattern 5 — Explicit Model Pin (no keywords)

**Inputs:** `model: "mistral-small-latest"` only.  
**Routing:** Bypasses classifier entirely — model pinned to Mistral Small.

```json
{
  "messages": [{ "role": "user", "content": "What is 2+2? Reply with just the number." }],
  "model": "mistral-small-latest"
}
```

**Live response (with bridge-compatible headers):**

| Field | Value |
|-------|-------|
| Routed model | `mistral-small-latest` (Mistral AI) |
| `x-ratelimit-remaining-req-minute` | `59` |
| `x-ratelimit-remaining-tokens-minute` | `374970` |
| `x-ratelimit-tokens-query-cost` | `30` |
| Response | `"4"` |
| Latency | ~1 s |

> **Bridge active**: Mistral returns `x-ratelimit-remaining-tokens-minute: 374970`.  
> `LLMExecutor` writes `context.providerRemainingTokens = 374970`.  
> `ContextManager.compress()` would use this as `effectiveTarget` (≈375k tokens), allowing full context.

---

### Pattern 6 — Keyword + Explicit Model (both set)

**Inputs:** `keywords: ["coding", "debug", "error"]` + `model: "llama-3.3-70b-versatile"`.  
**Routing:** Model pinned; keywords enrich the system prompt with coding context.

```json
{
  "messages": [{ "role": "user", "content": "What causes 'Cannot read properties of undefined' in JavaScript? One sentence." }],
  "keywords": ["coding", "debug", "error"],
  "model": "llama-3.3-70b-versatile"
}
```

**Live response (with bridge-compatible headers):**

| Field | Value |
|-------|-------|
| Routed model | `llama-3.3-70b-versatile` (Groq) |
| `x-ratelimit-remaining-requests` | `999` |
| `x-ratelimit-remaining-tokens` | `10924` |
| `x-ratelimit-reset-tokens` | `5.38s` |
| Response | 1-sentence explanation of undefined property access |
| Latency | <1 s (Groq hardware) |

> **Bridge active**: Groq returns `x-ratelimit-remaining-tokens: 10924`.  
> `context.providerRemainingTokens = 10924` — tight budget.  
> On a long follow-up, ContextManager would compress to 10924 tokens instead of Llama's full 128k static window.

---

### Pattern 7 — SQL Keyword Routing

**Inputs:** `keywords: ["sql", "database"]`, no model.  
**Routing:** `sql` and `database` both map to `coding` tier → code model selected.

```json
{
  "messages": [{ "role": "user", "content": "Write a SQL query to find duplicate email addresses in a users table." }],
  "keywords": ["sql", "database"]
}
```

**Live response:**

| Field | Value |
|-------|-------|
| Routed model | `codestral-latest` (LLM7.io) |
| Output | Two complete SQL queries: `GROUP BY + HAVING` and `INNER JOIN` variant |
| Latency | ~3 s |

---

### Pattern 8 — Summarization Keyword + Explicit Gemini Model

**Inputs:** `keywords: ["coding", "api", "python"]` + `model: "gemini-2.5-flash"`.  
**Routing:** Pinned to Gemini 2.5 Flash; keywords inject python/API context.

```json
{
  "messages": [{ "role": "user", "content": "Write a Python snippet calling requests.get() with retry logic. Code only." }],
  "keywords": ["coding", "api", "python"],
  "model": "gemini-2.5-flash"
}
```

**Live response:**

| Field | Value |
|-------|-------|
| Routed model | `gemini-2.5-flash` (Google Gemini) |
| Provider headers | No `x-ratelimit-*` (Gemini doesn't expose token quotas in headers) |
| Output | Complete `get_with_retry()` with exponential backoff, type hints, docstring |
| Tokens used | prompt: 17, completion: 935, total: 2229 |
| Latency | ~12 s (largest generation) |

> **Bridge**: Gemini provides no `x-ratelimit-*` headers.  
> `providerRemainingTokens` stays `undefined`. ContextManager uses static window (1M tokens for Flash).

**Exact Output**

```python
import requests
import time

def get_with_retry(
    url: str,
    max_retries: int = 3,
    backoff_factor: float = 0.5,
    **kwargs
) -> requests.Response:
    """
    Calls requests.get() with retry logic for network-related and HTTP 5xx errors.

    Args:
        url (str): The URL to request.
        max_retries (int): The maximum number of times to retry the request.
                           Defaults to 3.
        backoff_factor (float): Factor by which to multiply the sleep duration
                                for exponential backoff
                                (sleep_time = backoff_factor * (2 ** attempt)).
                                Defaults to 0.5 (0.5s, 1s, 2s, ...).
        **kwargs: Additional keyword arguments to pass to requests.get()
                  (e.g., timeout, headers, params).

    Returns:
        requests.Response: The response object if the request is successful.

    Raises:
        requests.exceptions.RequestException: If the request fails after all retries.
    """
    for attempt in range(max_retries):
        try:
            response = requests.get(url, **kwargs)

            # Raise an HTTPError for bad responses (4xx or 5xx)
            # This makes 5xx errors trigger a retry.
            response.raise_for_status()
            return response

        except requests.exceptions.RequestException as e:
            if attempt < max_retries - 1:
                sleep_time = backoff_factor * (2 ** attempt)
                print(
                    f"Request failed (attempt {attempt + 1}/{max_retries}): {e}. "
                    f"Retrying in {sleep_time:.2f} seconds..."
                )
                time.sleep(sleep_time)
            else:
                print(f"Request failed after {max_retries} attempts: {e}")
                raise  # Re-raise the last exception if all retries fail


# Example Usage (uncomment to test):
# if __name__ == "__main__":
#     # This URL will succeed
#     successful_url = "https://httpbin.org/get"
#
#     # This URL will return a 500 status code, triggering retries
#     failing_url_500 = "https://httpbin.org/status/500"
#
#     # This URL will likely cause a connection error
#     non_existent_url = "https://this-domain-does-not-exist-12345.com"
#
#     print("--- Testing successful request ---")
#     try:
#         response = get_with_retry(successful_url, max_retries=2, timeout=5)
#         print(f"Success! Status code: {response.status_code}")
#         # print(response.json())
#     except requests.exceptions.RequestException as e:
#         print(f"Failed to fetch {successful_url}: {e}")
#
#     print("\n--- Testing request with 500 error (expected to fail after retries) ---")
#     try:
#         response = get_with_retry(
#             failing_url_500,
#             max_retries=3,
#             backoff_factor=0.1,
#             timeout=2
#         )
#         print(f"Success! Status code: {response.status_code}")
#     except requests.exceptions.RequestException as e:
#         print(f"Failed as expected to fetch {failing_url_500}: {e}")
#
#     print("\n--- Testing request with connection error (expected to fail after retries) ---")
#     try:
#         response = get_with_retry(
#             non_existent_url,
#             max_retries=3,
#             backoff_factor=0.1,
#             timeout=1
#         )
#         print(f"Success! Status code: {response.status_code}")
#     except requests.exceptions.RequestException as e:
#         print(f"Failed as expected to fetch {non_existent_url}: {e}")
```

---

## Bridge Signal Coverage

| Provider | `x-ratelimit-remaining-tokens` header | Bridge active |
|----------|---------------------------------------|---------------|
| Groq | ✅ `x-ratelimit-remaining-tokens` | ✅ Yes |
| Mistral | ✅ `x-ratelimit-remaining-tokens-minute` | ✅ Yes |
| OpenAI | ✅ `x-ratelimit-remaining-tokens` | ✅ Yes |
| NVIDIA NIM | ✅ `x-ratelimit-remaining-tokens` | ✅ Yes |
| Gemini | ❌ (quota via separate API) | ❌ No — static fallback |
| Cloudflare | ❌ (no rate-limit headers) | ❌ No — static fallback |
| LLM7.io | ❌ (no rate-limit headers) | ❌ No — static fallback |
| Cohere | ❌ (no rate-limit headers in response) | ❌ No — static fallback |

> When bridge is inactive, `ContextManager.compress()` gracefully falls back to the caller-provided static `targetTokens`.

---

## Routing Decision Matrix

| Inputs | Classifier runs | Model selected by |
|--------|-----------------|-------------------|
| No keywords, no model | Yes (fallback to default) | First available provider |
| Keywords only | Yes (majority-voting) | Task-tier map |
| Model only | No | Pinned model |
| Keywords + model | No | Pinned model + keyword-enriched prompt |

---

## Provider Headers Reference

Headers parsed by `LLMExecutor.updateTokenTracking()` and bridged via `providerRemainingTokens`:

```
x-ratelimit-remaining-tokens        ← Groq, OpenAI, NVIDIA
x-ratelimit-remaining-tokens-minute ← Mistral
x-ratelimit-limit-tokens            ← Groq
x-ratelimit-reset-tokens            ← Groq (time until refill)
x-ratelimit-tokens-query-cost       ← Mistral (cost of last request)
```

---

## See Also

- [`SAMPLES.md`](SAMPLES.md) — Full agentic simulation traces with token/latency benchmarks
- [`../README.md`](../README.md) — Pipeline architecture overview
- [`../docs/guide.md`](../docs/guide.md) — Integration guide for tool consumers
