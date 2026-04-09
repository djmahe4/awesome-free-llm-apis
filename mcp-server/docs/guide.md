# Workflow & Architecture Guide

This guide explains the inner workings of the LLM Orchestration Pipeline, including routing logic, token management, and middleware execution.

## 1. Orchestration Pipeline Flow (v1.0.1 Update)

The system uses a middleware-based pipeline. Every request passes through a series of "layers" before reaching the LLM provider.

### Simplified Pipeline (v1.0.1)

The pipeline was simplified in v1.0.1 - Router now handles token management and execution internally:

```mermaid
sequenceDiagram
    participant U as User / Tool Call
    participant E as PipelineExecutor
    participant C as CacheMiddleware
    participant A as AgenticMiddleware
    participant R as RouterMiddleware
    participant X as LLMExecutor (utility)
    participant P as LLM Provider

    U->>E: execute(request, taskType)
    E->>C: Process
    C->>C: Check Memory & Disk Cache
    alt Cache Hit
        C-->>U: Return Cached Response
    else Cache Miss
        C->>A: next()
        A->>A: Setup agentic mode (if enabled)
        A->>R: next()
        R->>R: Map Task to Model Tier
        loop For each model in tier (fallback)
            R->>X: tryProvider(modelId, providerId)
            X->>X: Calculate & Check Tokens
            X->>P: HTTPS Request
            alt Success
                P-->>X: Response + Headers
                X->>X: Update Token Tracking
                X-->>R: Return Response
                R->>E: next() [CALLED ONCE]
                E-->>U: Final Result
            else Provider Error / Rate Limit
                P-->>X: Error
                X-->>R: Throw Error
                R->>R: Continue to next fallback
            end
        end
        alt All fallbacks exhausted
            R-->>U: Error: No providers available
        end
    end
```

### Pipeline Order

**v1.0.1 (Current):**
1. `ResponseCache` - Check cache for existing response
2. `AgenticMiddleware` - Handle agentic/reasoning mode
3. `Router` - Select provider/model + execute (includes token management)

**v1.0.0 (Old):**
1. ResponseCache
2. AgenticMiddleware
3. Router
4. TokenManager ❌ (removed - now in Router)
5. LLMExecution ❌ (removed - now in Router)

### Key Architectural Change

The Router now calls `next()` **exactly once** after successfully selecting a provider, instead of calling it multiple times in a fallback loop. This fixes the critical `"next() called multiple times"` error.

## 2. Intelligent Routing Logic (v1.0.1 Update)

The `IntelligentRouterMiddleware` dynamically maps abstract tasks to a prioritized list of models, with **FREE models prioritized first**. The router now utilizes all 79 models across 15 providers.

### Free-First Routing Strategy

The router prioritizes FREE models (OpenRouter `:free`, GitHub Models, Cloudflare) before falling back to paid options:

1. **Cloudflare** (100% success, fastest): `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, `@cf/qwen/qwq-32b`
2. **GitHub Models** (free tier): `gpt-4o`, `Llama-3.3-70B-Instruct`, `DeepSeek-R1`
3. **OpenRouter Free** (`:free` suffix models): Various specialized models
4. **Paid Providers**: Gemini, Mistral, Cohere, etc.

### Fallback Cascade Behavior

If the first choice is unavailable (e.g., missing API key, rate limited, or timeout), it cascades to the next best option **without throwing an error**:

```typescript
// Router tries providers using LLMExecutor (no multiple next() calls)
for (const modelId of tierModels) {
    for (const provider of availableProviders) {
        try {
            const response = await executor.tryProvider(context, provider.id, modelId);
            if (response) {
                context.response = response;
                await next(); // Called ONCE after success
                return;
            }
        } catch (error) {
            // Continue to next fallback
        }
    }
}
```

### Task-Based Model Mapping

Each task type has an optimized model tier based on real-world testing:

```mermaid
graph TD
    A[Incoming Request] --> B{Task Type?}
    
    B -- Coding --> C[Tier: Cloudflare QwQ -> Qwen Coder 480B -> Gemini Pro]
    B -- Moderation --> D[Tier: Cloudflare Llama -> Nemotron Mini -> Gemini Flash]
    B -- Chat --> E[Tier: Cloudflare Llama -> GPT-4o -> Llama 3.3 70B]
    B -- Semantic Search --> F[Tier: Trinity Large -> Cloudflare -> Command R+]
    
    C --> G{Available?}
    D --> G
    E --> G
    F --> G
    
    G -- Yes --> H[Execute with LLMExecutor]
    G -- No --> I[Next in Tier]
    I --> G
    
    I -- Exhausted --> J[Error: All providers failed]
```

### Provider Coverage (v1.0.1)

| Provider | Models | Usage | Success Rate |
|----------|--------|-------|--------------|
| Cloudflare | 2 | 100% | 100% (1307ms avg) ✨ |
| OpenRouter | 13 | 80% | 60-100% (varies by model) |
| GitHub Models | 3 | 100% | High (free tier) |
| Cohere | 3 | 67% | 100% (2539ms avg) |
| Gemini | 7 | 86% | High |
| Groq | 3 | 33% | High (fast inference) |
| All Others | 48+ | Various | Various |

**Total: 15 providers, 79 models**

## 3. Token Management & Synchronization (v1.0.1 Update)

The pipeline maintains a local "interpolated" token count to prevent overwhelming providers and hitting hard limits. In v1.0.1, token management is handled by the `LLMExecutor` utility class, which is called directly by the router during fallback attempts.

### Token Management Flow

1. **Local Estimation**: Before a request, `js-tiktoken` estimates the input tokens
2. **Proactive Blocking**: If the estimated usage exceeds the remaining quota, the request is blocked or routed elsewhere
3. **Provider Execution**: `LLMExecutor.tryProvider()` combines token checks + API call in one atomic operation
4. **Response Sync**: After a successful call, the executor reads `x-ratelimit-remaining-tokens` headers to update the ground truth

```mermaid
graph LR
    A[Router Selects Model] --> B[LLMExecutor.tryProvider]
    B --> C[Estimate Tokens]
    C --> D{Within Quota?}
    D -- No --> E[Throw Error → Try Next Fallback]
    D -- Yes --> F[Deduct Tokens]
    F --> G[Call Provider]
    G --> H[Capture Headers]
    H --> I[Update Local Quota]
    I --> J[Return Response]
```

### Architecture Change (v1.0.1)

**Before:**
```
Router → next() → TokenManager → next() → LLMExecution
  ↓        ↓                         ↓
Multiple next() calls = ERROR!
```

**After:**
```
Router → LLMExecutor.tryProvider() → [Token Check + API Call + Tracking]
  ↓
Single next() call after success = WORKS!
```

### Recent Fixes (v1.0.1)

The architecture was refined based on PR review feedback:

1. **Token Replenishment**: `LLMExecutor.hasEnoughTokens()` now checks refresh times and clears tracking when tokens should have replenished, preventing indefinite blocking.

2. **Type Safety**: Header handling improved from `any` to `Record<string, string | string[] | undefined>` with proper array handling for multi-value headers.

3. **State Management**: Router now exposes `flush()` method to clear token tracking. Dead code (`sharedTokenManager`) removed from pipeline.

4. **Token Stats Integration**: `get-token-stats` tool now reads from router's actual token state instead of unused middleware.

All tests pass and the system handles token refresh correctly.

## 4. MCP Tools Interaction

The server exposes exactly **six public tools** for LLM interaction, discovery, and system management. Agents must use only these six tools — never request additional tools.

### Tool Discovery Handshake
The system follows the standard MCP lifecycle:
1.  **Initialize**: Client connects and receives capabilities. Note that `capabilities.tools` returns an empty object `{}` per spec to signal support.
2.  **List Tools**: Client calls `tools/list` to receive the full JSON schema for all available tools with rich descriptions.

> **Agent Rule**: Always call `manage_memory` (action: "search") before wide-context actions.

### 1. `use_free_llm`
Universal chat interface with automatic fallback cascade through 60+ free models.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `model` | string | ❌ | Model ID (e.g. `llama-3.3-70b-versatile`, `gemini-2.5-flash`) |
| `messages` | array | ✅ | Array of `{role, content}`. Roles: `system` \| `user` \| `assistant` |
| `provider` | string | ❌ | Pin to a specific provider, bypassing routing |
| `temperature` | number | ❌ | Sampling temperature 0.0–2.0 (default 0.7) |
| `max_tokens` | number | ❌ | Maximum tokens to generate (default 1024) |
| `workspace_root` | string | ❌ | Path to workspace for cache-keying and sessionId derivation |
| `fallback` | boolean | ❌ | Enable provider fallback cascade (default true) |
| `agentic` | boolean | ❌ | Enable agentic mode (task decomposition + system prompt injection) |
| `sessionId` | string | ❌ | Required for agentic mode — partitions state/logs per project |

### 2. `list_available_free_models`
Discover all supported models across all providers with rate-limit metadata.
- **`available_only: true`** — filters to providers with active API keys configured.
- **`provider: "groq"`** — filter to a specific provider.

### 3. `manage_memory`
Interface for the persistent, workspace-aware memory system.

- **Actions**: `search`, `list`, `stats`, `clear`.
- **Architecture**: All memory is physically stored centrally in the MCP server's local `data/memory.json`. The `workspace_root` parameter generates a unique cryptographic hash as a **logical namespace** to safely isolate context between projects.
- **Agent Rule**: Call `manage_memory` with `action: "search"` before wide-context steps to recall relevant prior work.

### Dynamic Prompt Synchronization (v1.0.3 Update)
The `prompt.json` engine uses a non-blocking, asynchronous loading strategy with automatic cache invalidation.

> [!NOTE]
> For a detailed explanation of how sections are scored and compressed, see the [Agentic Prompt Injection Guide](agentic-prompts.md).

- **Efficiency**: Uses `fs.stat()` to check `mtime` before every use.
- **Zero Restart**: Prompt updates are picked up instantly without requiring a server restart.
- **Asynchronous**: Built entirely on `fs.promises` to keep the event loop free.

### 4. `code_mode`
Executes code in a sandboxed runtime — only `stdout` enters context, never the raw DATA payload.

| Language | Sandbox Engine | Notes |
|----------|---------------|-------|
| `javascript` (default) | QuickJS via `quickjs-emscripten` | In-process, no external deps |
| `python` | RestrictedPython subprocess runner | Requires `python3` on PATH; `pip install RestrictedPython` |
| `go` | goja (pure-Go ECMAScript engine) | Pre-built binary required; see `scripts/go-sandbox-runner/` |
| `rust` | boa_engine (pure-Rust ECMAScript) | Pre-built binary required; see `scripts/rust-sandbox-runner/` |

- **DATA global**: raw input string injected into the sandbox before execution.
- **Use Case**: Process large API responses locally. Pass `compressionRatio < 1` output to LLM instead of raw data — saves up to 95% of context window.
- **Security**: No filesystem, no network, no process/OS access in any language sandbox.
- **Build sandbox runners**:
  ```bash
  # Go (goja)
  cd scripts/go-sandbox-runner && go build -o sandbox-runner .
  # Rust (boa_engine)
  cd scripts/rust-sandbox-runner && cargo build --release
  ```

### 5. `get_token_stats` & `validate_provider`
Utility tools for monitoring system health and verifying provider credentials.
- `get_token_stats`: returns per-provider `{id, name, isAvailable, rateLimits, usage}`.
- `validate_provider`: runs a live health check on a specific provider ID.

## 5. Visual Dashboard & SSE Bridge

The server includes a Bootstrap 5 dashboard for real-time monitoring. By default, it runs on port 3000 when starting via `npm run dashboard`.

### 5.1 Dashboard Overview
The main landing page provides high-level statistics about the orchestration health, including total providers configured, active credentials, and the currently operational automation status (Token Interpolation, Header Sync, and Auto-Fallback).

![Dashboard Overview](./assets/dashboard_overview.png)

### 5.2 Provider Tracking
The Provider Tracking tab offers a granular look at every configured LLM backend. It shows real-time quota status, current token/request usage, and provides a **Verify Credential** diagnostic tool to check connectivity and API key validity instantly.

![Provider Tracking](./assets/dashboard_provider.png)

### 5.3 Communication Architecture
```mermaid
graph LR
    subgraph Browser
        D[Dashboard UI] -->|Update UI| E[fetch /api/token-stats]
        D -->|Manual Check| V[fetch /api/validate-provider]
        D -->|Real-time| S[SSE /mcp]
    end
    subgraph Server
        E -->|Call| F[getTokenStats Logic]
        V -->|Execute| H[validateProvider Logic]
        H -->|Minimal Call| P[LLM Provider]
        F -->|Read| G[TokenManager State]
        S -->|Status| J[Streaming Provider State]
    end
```

To enable the dashboard and remote MCP access, start the server using the `--sse` flag or `npm run dashboard`. This switches the transport from `stdio` to `StreamableHTTPServerTransport` and exposes the unified `/mcp` endpoint and API bridge on port 3000.

## 6. Professional Credential Validation

The system implements a multi-tier validation strategy to ensure high reliability:

1.  **Pattern Hardening**: `BaseProvider.isAvailable()` automatically filters out common placeholders (e.g., `your_github_token_here`) and extremely short keys.
2.  **Live Health Checks**: The `validate_provider` tool/API executes a real, minimal chat completion call with `max_tokens: 1`. This confirms that the key is not only present but also valid and authorized by the provider.
3.  **UI Feedback**: In the dashboard, each provider card features a **Verify Credential** button, allowing developers to immediately troubleshoot configuration issues without looking at server logs.

## 7. Security & Networking Architecture

When the server runs in HTTP/SSE mode (e.g., via `--sse` or `npm run dashboard`), it leverages robust web security practices to protect the MCP integration and dashboard:

1.  **Strict CORS Policy**: `cors()` middleware ensures that cross-origin requests are appropriately managed, preventing unauthorized domains from interacting with the `/mcp` or API endpoints.
2.  **Helmet Integration**: The extensive `helmet()` middleware provides multiple layers of defense:
    *   **Content Security Policy (CSP)**: Restricts scripts and styles to `'self'` and explicitly trusted CDNs (like `https://cdn.jsdelivr.net`), mitigating XSS risks.
    *   **HTTP Strict Transport Security (HSTS)**: Forces clients to interact over secure channels, with `includeSubDomains: true` and `preload: true`.
    *   It also automatically strips vulnerable headers (like `X-Powered-By`) and configures `X-Frame-Options` and strict MIME sniffing.

## 8. Agentic Middleware v2

The optional **Agentic Middleware** (`src/middleware/agentic/`) adds a structured, self-improving execution layer on top of the existing pipeline.

### What it does

| Feature | Description |
|---------|-------------|
| **System Prompt Injection** | Prepends the tailored system prompt to every request, loaded dynamically via `getIntelligentSystemPrompt()`. |
| **Task Decomposition** | Splits the user goal into discrete steps and seeds the `nowQueue`. |
| **Momentum Queues** | In-memory `nowQueue`, `nextQueue`, `blockedQueue`, and `improveQueue` per session, persisted to `projects/{sessionId}/queues.json`. |
| **File-First State** | Creates `projects/{sessionId}/plan.md`, `tasks.md`, and `knowledge.md` on first use. |
| **Verification Loop** | After each step, performs a self-check LLM call. Failed verifications are enqueued to `improveQueue`. |

### How it uses the external prompt (v1.0.3 Update)

The prompt loader (`src/middleware/agentic/prompts.ts`) resolves the system prompt asynchronously on its first use and memoizes the result. It uses a keyword-based scoring mechanism to select relevant documentation.

> [!NOTE]
> For a deep dive into the scoring algorithm, categorization, and reference compression, see the [Agentic Prompt Injection](agentic-prompts.md) documentation.

1. Checks `external/agent-prompt/prompt.json` (Tier 1: Pre-computed, optimized).
2. Falls back to `external/agent-prompt/README.md` (Tier 2: Raw Markdown).
3. Uses a hardcoded default (Tier 4) if all external sources are unavailable.

The async function `getIntelligentSystemPrompt()` is used to ensure non-blocking server initialization. Subsequent calls are served from an in-memory cache.

### Enabling the middleware

The Agentic Middleware supports a **Dual-Mode Trigger** for both global automation and selective opt-in. In **all** modes, providing a valid **`sessionId` is mandatory** for agentic state to be created.

#### 1. Global Mode (`.env`)
Set the environment variable to enable the agentic layer for requests that provide a `sessionId`. Requests without an ID will bypass the agentic layer with a warning.

```sh
ENABLE_AGENTIC_MIDDLEWARE=true npm run dev
```

#### 2. Selective Mode (Per-Request)
You can opt-in on a per-call basis by passing `"agentic": true` in the request body along with a **`sessionId`**.

| Trigger | `ENABLE_AGENTIC_MIDDLEWARE` | `request.agentic` | `sessionId` | Result |
|:---|:---|:---|:---|:---|
| **Global** | `true` | (Any) | **Mandatory** | Agentic ON |
| **Opt-In** | `false`/Unset | `true` | **Mandatory** | Agentic ON |
| **Missing ID**| (Any) | (Any) | Missing | **Agentic OFF** (Bypass) |

Without a `sessionId` and a trigger, the middleware is a transparent pass-through with zero overhead.

#### 3. How to Create a Session ID

The system is now **Foolproof and Zero-Config** by default:

- **Option A (Automatic - Recommended)**: Simply provide a `workspace_root` (e.g., your project's absolute path). The server will automatically derive a deterministic `sessionId` (namespaced as `ws-[hash]`) from that path. This ensures persistent reasoning for that project without any extra effort.
- **Option B (Explicit Override)**: For advanced use cases (e.g. multi-agent coordination), you can explicitly provide your own `sessionId` in the request.
- **Persistence**: Both methods ensure your agent's memory and reasoning are tied to a dedicated directory on the server's disk (`mcp-server/projects/`).

### Example flow

```
User: "Build a REST API with auth and tests"
  │
  ▼
AgenticMiddleware.execute()
  ├─ Await prependSystemPrompt(messages) (Dynamic/Async)
  ├─ Decompose goal → steps ["Build REST API", "Add auth", "Write tests"]
  ├─ nowQueue = ["Build REST API", "Add auth", "Write tests"]
  ├─ Persist queues.json + ensure plan.md / tasks.md / knowledge.md
  ├─ Call next() → existing pipeline (Cache → Router → Token → LLM)
  ├─ Verification: self-check response via second LLM call
  │    ├─ PASS → continue
  │    └─ FAIL → push reason to improveQueue
  └─ Shift nowQueue, persist state
```

---

### High-Density Synthesis for Multi-Agent Workflows

This section shows how to orchestrate multiple independent agent sessions and then synthesise their outputs into a single coherent result with minimal token overhead.

#### How sessions share memory via `knowledge.md`

Every session created by `AgenticMiddleware` gets an isolated directory:

```
data/projects/
├── session-backend/      ← Agent A (API implementation)
│   ├── knowledge.md      ← Accumulated facts & decisions
│   ├── plan.md
│   └── queues.json
├── session-frontend/     ← Agent B (UI layer)
│   ├── knowledge.md
│   └── ...
└── session-synthesiser/  ← Agent C (final merge)
    └── knowledge.md
```

A **synthesiser agent** can read the `knowledge.md` of the specialist agents and compose a final output. Because `StructuralMarkdownMiddleware` (v1.0.4) injects the **full** `knowledge.md` on every turn, the synthesiser never has a partial view of prior state.

#### How `StructuralMarkdownMiddleware` enables clean handoff

When `agentic: true` is set and a `sessionId` is supplied, the middleware prepends this block into the user message **before any LLM call**:

```
# TASK CONTEXT
<original user message>

# FULL MEMORY STATE (session session-backend)
<entire knowledge.md — no truncation>

# RESPONSE FORMAT
Reply only in clean Markdown. For any code or file changes use exactly this block:
```file:relative/path/from/session/root.ts
// FULL file content here (never partial diffs)
```
```

This means the receiving agent has full context with zero prompt-engineering overhead. Handoff between agents is simply switching `sessionId`.

#### Example 1 — Parallel feature development + synthesis

```typescript
// Agent A: implement the data model
await client.callTool('use_free_llm', {
  messages: [{ role: 'user', content: 'Implement the User model with Zod validation' }],
  agentic: true,
  sessionId: 'session-model',
});

// Agent B: implement the HTTP layer (runs concurrently)
await client.callTool('use_free_llm', {
  messages: [{ role: 'user', content: 'Implement POST /users endpoint with Express' }],
  agentic: true,
  sessionId: 'session-http',
});

// Agent C: synthesise — reads both knowledge.md files via store_memory
await client.callTool('store_memory', {
  key: 'model-summary',
  content: fs.readFileSync('data/projects/session-model/knowledge.md', 'utf-8'),
  workspace_root: '/my-project',
});
await client.callTool('store_memory', {
  key: 'http-summary',
  content: fs.readFileSync('data/projects/session-http/knowledge.md', 'utf-8'),
  workspace_root: '/my-project',
});

await client.callTool('use_free_llm', {
  messages: [{
    role: 'user',
    content: 'Using the model and HTTP layer outputs stored in memory, write integration tests covering all endpoints.',
  }],
  agentic: true,
  sessionId: 'session-tests',
  workspace_root: '/my-project',   // triggers memory lookup for both keys above
});
```

**Token savings:** Each specialist agent's `knowledge.md` is typically 200–600 tokens after compression. Injecting two summaries (≈1 000 tokens total) is **90% cheaper** than re-running both agents in the same context window.

#### Example 2 — Research → Synthesise → Implement pipeline

```typescript
// Turn 1 — research agent gathers facts
const researchSession = 'project-research';
await client.callTool('use_free_llm', {
  messages: [{ role: 'user', content: 'Research the best JWT refresh-token strategies for Node.js 2025' }],
  agentic: true, sessionId: researchSession,
  keywords: ['research', 'security', 'jwt'],
});

// Turn 2 — implementation agent reads the research knowledge.md via structural middleware
await client.callTool('use_free_llm', {
  messages: [{
    role: 'user',
    content: 'Implement the best JWT strategy identified in the research. Write full TypeScript source.',
  }],
  agentic: true,
  sessionId: 'project-impl',
  // StructuralMarkdownMiddleware will inject 'project-research/knowledge.md' if you copy it:
  // cp data/projects/project-research/knowledge.md data/projects/project-impl/knowledge.md
});
```

#### Example 3 — Summarising 2-3 parallel agent outputs

Use this prompt pattern when three agents produce independent outputs and you need a single consolidated answer:

```
# SYNTHESIS TASK
You are the synthesis agent. Below are the outputs of three specialist agents.
Merge them into a single coherent document. Eliminate redundancy.
Preserve every unique fact, decision, and code snippet.
Output only the merged document — no commentary.

## Agent A output (session-a/knowledge.md)
${knowledgeA}

## Agent B output (session-b/knowledge.md)
${knowledgeB}

## Agent C output (session-c/knowledge.md)
${knowledgeC}
```

Call this with `agentic: false` (no further decomposition needed — it's a single-shot merge):

```typescript
await client.callTool('use_free_llm', {
  messages: [{
    role: 'user',
    content: synthPrompt,  // the template above, filled in
  }],
  agentic: false,
  keywords: ['summarization'],   // routes to a high-context model tier
  max_tokens: 2048,
});
```

#### Benefits at a glance

| Metric | Single monolithic agent | Multi-agent + synthesis |
|--------|------------------------|------------------------|
| Context per turn | 12 000–32 000 tokens | 800–2 000 tokens |
| Parallelism | None | Full (agents run concurrently) |
| Memory persistence | In-context only | `knowledge.md` survives restarts |
| Handoff clarity | Implicit (entire history) | Explicit (structured Markdown blocks) |
| Final output quality | Degrades with depth | Consistent — synthesiser sees full state |

