# free-llm-apis MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes **seven focused tools** for interacting with 60+ free LLM providers through a unified, agent-first interface.

---

## Architecture Overview

```mermaid
graph TD
    A[Agent / Client<br/>Claude · Cursor · Windsurf] -->|MCP Tool Call| B[MCP Server<br/>src/mcp/index.ts]
    B --> C[PipelineExecutor]
    
    subgraph "Core Tools & Subsystems"
        J[MemoryManager<br/>src/memory/]
        K[SandboxExecutor<br/>src/sandbox/]
    end

    C --> D[StructuralMarkdownMiddleware<br/>src/middleware/agentic/structural-middleware.ts]
    D -->|Agentic requests: inject full session memory| E[ResponseCacheMiddleware]
    E -->|Cache Miss| F[AgenticMiddleware]
    F --> G[IntelligentRouterMiddleware]
    G -->|Tier selection + fallback| H[LLMExecutor<br/>Headers + Error Recovery]
    H --> I[(Free LLM Provider)]

    C --> J[MemoryManager<br/>src/memory/]
    C --> K[SandboxExecutor<br/>src/sandbox/]
    
    D -->|"Pass-through (non-agentic)"| E
    E -->|Cache Hit| A
    I --> H --> G --> F --> E --> D --> A

    style D fill:#ffd54f,stroke:#f57f17
    style F fill:#ffe082,stroke:#f9a825
    style E fill:#b3e5fc,stroke:#0288d1
    style G fill:#c8e6c9,stroke:#388e3c
    style J fill:#f8bbd0,stroke:#c2185b
    style K fill:#f3e5f5,stroke:#7b1fa2
```

### Pipeline Order (v1.0.4)

| Stage | Component | Purpose |
|-------|-----------|---------|
| 1 | `StructuralMarkdownMiddleware` *(new v1.0.4)* | Injects full `knowledge.md` session memory into agentic requests; enforces structured response format |
| 2 | `ResponseCacheMiddleware` | LRU + disk cache; workspace-hash keyed |
| 3 | `AgenticMiddleware` *(optional)* | Task decomposition (max 4 steps), research validation, system prompt injection, early-exit on confidence > 0.85 or 3 iterations |
| 4 | `IntelligentRouterMiddleware` | Deterministic keyword-based model-tier selection with FREE-first fallback cascade |
| 5 | `LLMExecutor` | HTTPS request to provider; token tracking via response headers + **reactive drift correction** + **bridge: writes `providerRemainingTokens` into context for ContextManager** |

---

## Seven Public Tools

> **Strict rule for agents:** Only these seven tools are part of the public API. Never request additional tools. Prefer internal middleware changes to extend capability.

| Tool | Purpose | Required Params | Key Optional Params |
|------|---------|----------------|---------------------|
| `use_free_llm` | Universal chat with deterministic steering; returns ONLY text content | `messages` | `model`, `keywords`, `agentic`, `sessionId`, **`workspace_root`** (recommended for project tasks) |
| `list_available_free_models` | Enumerate providers and models with metadata | *(none)* | `provider`, `available_only` |
| `get_token_stats` | Real-time per-provider usage and quota stats | *(none)* | — |
| `validate_provider` | Health-check and credential validation | `providerId` | — |
| `code_mode` | Sandboxed script execution; only stdout returned | `code` | `language`, `data`, `timeout_ms` |
| `manage_memory` | Workspace-scoped memory: search/list/stats/clear | `action` | `workspace_root`, `query`, `limit` |
| `store_memory` | Explicitly inject persistent context/facts into memory | `key`, `content` | `workspace_root` |

#### `code_mode` Sandbox Runtimes

| `language` | Engine | Script Language | External Requirement |
|------------|--------|----------------|---------------------|
| `javascript` (default) | QuickJS (`quickjs-emscripten`) | JavaScript | None — in-process |
| `python` | RestrictedPython | Python | `python3` on PATH; `pip install RestrictedPython` |
| `go` | goja (pure-Go ECMAScript) | JavaScript | Pre-built binary: `cd scripts/go-sandbox-runner && go build -o sandbox-runner .` |
| `rust` | boa_engine (pure-Rust ECMAScript) | JavaScript | Pre-built binary: `cd scripts/rust-sandbox-runner && cargo build --release` |

### Sample Agent Invocations

**Before any wide-context action — always check memory first:**
```ts
await client.callTool('manage_memory', {
  action: 'search',
  workspace_root: '/src/app',
  query: 'authentication middleware'
});
```

**Discover available models:**
```ts
await client.callTool('list_available_free_models', { available_only: true });
```

**Project-scoped task (agentic + workspace_root — ALWAYS use for project work):**
```ts
// ⚠️ Both `agentic: true` AND `workspace_root` are required for memory injection.
// Omitting either produces a context-blind response with no memory or session enrichment.
await client.callTool('use_free_llm', {
  messages: [{ role: 'user', content: 'Refactor the auth module to use JWTs' }],
  agentic: true,
  workspace_root: '/abs/path/to/my-project',
  keywords: ['refactor', 'security', 'jwt']
});
```

**One-off query (no workspace, no memory — use for simple standalone Q&A):**
```ts
await client.callTool('use_free_llm', {
  messages: [{ role: 'user', content: 'What is the most efficient sorting algorithm?' }],
  keywords: ['coding', 'algorithms']
});
```

**Explicit model + keyword steering:**
```ts
await client.callTool('use_free_llm', {
  model: 'llama-3.3-70b-versatile',
  messages: [{ role: 'user', content: 'Explain JWT token expiry' }],
  keywords: ['security', 'tokens', 'jwt']
});
```

**Process large API response — JavaScript (default, no external deps):**
```ts
await client.callTool('code_mode', {
  language: 'javascript',
  code: 'const items = JSON.parse(DATA); print(items.map(i => i.name).join("\\n"))',
  data: largeApiResponse,
  command: 'Extract item names from API response'
});
```

**Process data with Python (requires `python3` + `pip install RestrictedPython`):**
```ts
await client.callTool('code_mode', {
  language: 'python',
  code: 'import json; items = json.loads(DATA); print(len(items))',
  data: jsonString
});
```

**Process with Go sandbox (requires pre-built binary):**
```ts
// Build first: cd scripts/go-sandbox-runner && go build -o sandbox-runner .
await client.callTool('code_mode', {
  language: 'go',
  code: 'var resp = JSON.parse(DATA); print(resp.total)',
  data: jsonString
});
```

**Process with Rust sandbox (requires pre-built binary):**
```ts
// Build first: cd scripts/rust-sandbox-runner && cargo build --release
await client.callTool('code_mode', {
  language: 'rust',
  code: 'var resp = JSON.parse(DATA); print(resp.total)',
  data: jsonString
});
```

**Validate a provider before a critical workflow:**
```ts
await client.callTool('validate_provider', { providerId: 'groq' });
```

**Check token consumption:**
```ts
await client.callTool('get_token_stats');
```

---

## Middleware Dataflow

```
Tool Call (use_free_llm)
        │
        ▼
PipelineExecutor.execute(request, taskType)
        │
        ▼ ─────────────────────────────────────
StructuralMarkdownMiddleware  (v1.0.4 — only when request.isAgentic is set)
  • Reads full knowledge.md for session into memory
  • Injects full memory state + response format instructions into user message
  • console.error() with Date.now() subtraction for standardized latency logging
        │
        ▼ ─────────────────────────────────────
ResponseCacheMiddleware
  • generateKey(request, workspaceHash)
  • If cache hit → return immediately (no LLM call)
  • If miss → next()
        │
        ▼ ─────────────────────────────────────
AgenticMiddleware  (only when agentic:true or ENABLE_AGENTIC_MIDDLEWARE=true)
  • Requires sessionId (auto-derived from workspace_root if not provided)
  • detectResearchIntent(userContent) → logs [RESEARCH-VALIDATION] if detected
  • decomposeGoal(userContent) → limitSubtasks() caps plan to 4 steps (v1.0.4)
  • prependSystemPrompt(context) → dynamic prompt + HIGH-LEVEL STEPS section (v1.0.4)
  • next()
  • verifySelf(response) → logs [VERIFY] on FAIL, pushes to improveQueue
  • confidenceScore > 0.85 or iterationCount >= 3 → early exit, clears nowQueue (v1.0.4)
  • Persists queue state to projects/{sessionId}/queues.json
        │
        ▼ ─────────────────────────────────────
IntelligentRouterMiddleware
  • Maps task type to model tier (FREE-first: Cloudflare → GitHub → OpenRouter → paid)
  • Iterates fallback list, calls LLMExecutor.tryProvider()
  • On success: context.response = response; next() called ONCE
  • On all-fail: throws "[Router] Exhausted all fallback models"
        │
        ▼ ─────────────────────────────────────
LLMExecutor
  • Estimates tokens (js-tiktoken)
  • Checks quota before request
  • Makes HTTPS request to provider
  • Updates token tracking from x-ratelimit-* headers + **reactive error interception**
  • **Bridge**: writes provider's remaining tokens into context.providerRemainingTokens
  •   → ContextManager.compress() reads this to override static model-window with live quota
  •   → Providers without headers degrade gracefully (static estimate used as fallback)
        │
        ▼ ─────────────────────────────────────
Response returned to agent
  • Simplified text content only (full JSON metadata stripped)
  • If multiple choices: Labeled as 'AGENT RESPONSE 1', 'AGENT RESPONSE 2', etc.
```

### Best Practices for Agent/Copilot Authors

1. **Always call `manage_memory` before wide-context steps** to retrieve relevant prior work.
2. **Use `code_mode` for any large-data processing** — never dump raw API responses into LLM context.
3. **For ANY project-scoped task, pass BOTH `agentic: true` AND `workspace_root`** — these two fields unlock memory injection, session persistence, and context enrichment. Passing only one (or neither) produces a context-blind, stateless response.
4. **Call `validate_provider` or `get_token_stats`** before long-running workflows to confirm quota.
5. **Research/external-knowledge requests are auto-logged** by `AgenticMiddleware` — check server logs for `[RESEARCH-VALIDATION]` entries.
6. **Prefer `available_only:true`** with `list_available_free_models` to skip unconfigured providers.

---

## Adding a New Provider in <20 Lines

See [`docs/mcp-development.md`](docs/mcp-development.md#adding-new-providers) for the full guide. Here is the minimal pattern:

```typescript
// 1. src/providers/my-provider.ts  (~10 lines)
import { BaseProvider } from './base.js';

export class MyProvider extends BaseProvider {
  name = 'My AI';
  id = 'my-ai';
  baseURL = 'https://api.myai.com/v1/';
  envVar = 'MY_AI_API_KEY';
  models = [
    { id: 'my-model-1', name: 'My Model 1' },
  ];
  rateLimits = { rpm: 20, rpd: 1000 };
}

// 2. src/providers/registry.ts  (add one import + one line)
import { MyProvider } from './my-provider.js';
// Inside constructor: allProviders.push(new MyProvider());
```

That's it. The router, token tracker, fallback, and validation logic all pick it up automatically.

---

## Client Configurations

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "free-llm-apis": {
      "command": "node",
      "args": ["/path/to/mcp-server/dist/src/server.js"],
      "env": {
        "GROQ_API_KEY": "your_key",
        "GEMINI_API_KEY": "your_key"
      }
    }
  }
}
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "free-llm-apis": {
      "command": "npx",
      "args": ["tsx", "/path/to/mcp-server/src/server.ts"],
      "env": {
        "GROQ_API_KEY": "your_key"
      }
    }
  }
}
```

### Windsurf (`~/.codeium/windsurf/mcp_config.json`)

```json
{
  "mcpServers": {
    "free-llm-apis": {
      "serverUrl": "http://localhost:3000/mcp",
      "headers": {}
    }
  }
}
```

*For HTTP transport, start the server with `npm run dashboard` (port 3000 by default).*

---

## Extension Points

### Adding Custom Middleware

Implement the `Middleware` interface and insert into the pipeline in `src/tools/use-free-llm.ts`:

```typescript
// src/pipeline/middlewares/my-middleware.ts
import type { Middleware, PipelineContext, NextFunction } from '../middleware.js';

export class MyMiddleware implements Middleware {
  name = 'MyMiddleware';
  async execute(context: PipelineContext, next: NextFunction): Promise<void> {
    // Pre-processing
    await next();
    // Post-processing
  }
}
```

### Strategy Patterns

| Strategy | Use Case | Implementation Hint |
|----------|----------|---------------------|
| **ReAct** | Reasoning + action loops | Extend `AgenticMiddleware` with action-observation cycles |
| **Plan-and-Execute** | Long multi-step tasks | Use `nowQueue`/`nextQueue` in agentic state |
| **Lite Mode** | Skip heavy middleware for simple calls | Set `agentic:false` and `fallback:true` with a pinned provider |
| **Cached-only** | Zero-latency repeat queries | Use workspace-aware cache keys; check hit rate with `manage_memory` stats |

---

## Quick Start

```bash
# Install and build
cd mcp-server
npm install
npm run build

# Configure providers (copy and fill .env.example)
cp .env.example .env

# (Optional) Build Go sandbox runner — for language:"go" in code_mode
cd scripts/go-sandbox-runner && go build -o sandbox-runner . && cd ../..

# (Optional) Build Rust sandbox runner — for language:"rust" in code_mode
cd scripts/rust-sandbox-runner && cargo build --release && cd ../..

# (Optional) Install Python RestrictedPython — for language:"python" in code_mode
pip install RestrictedPython
```
> Follow [setup.md](docs/setup.md) for more details.

# Run in stdio mode (for Claude Desktop / Cursor)
```bash
npm run start
```

# Run with HTTP dashboard (port 3000)
```bash
npm run dashboard
```

# Docker
```bash
docker-compose up
```

See [`.env.example`](.env.example) for all supported API key variables.

---

## Agentic Benchmarks

The MCP server includes a comprehensive benchmarking suite to measure the efficiency of its intelligent subsystems, showing typical **token savings of 90-95%** across real-world scenarios.


### 🧪 System Evidence (Zero-Mock Proofs)

Verification of the system's intelligence is grounded in **live, execution-based traces**:
- See [SAMPLES.md](benchmarks/SAMPLES.md) for 7 verified scenarios including **Project State Synthesis**, **Multi-Step Decomposition**, and **Deep Memorization Retrieval**.
- See [INTAKE.md](benchmarks/INTAKE.md) for a breakdown of the agent-server intake protocol.

---

## Reliable Persistent Memory

The server features a **hardened long-term memory system** designed for long-running agentic tasks:

- **Identity Hashes**: Workspaces are identified by stable, path-based hashes. Your stored facts persist even if you modify your codebase.
- **Anti-Poisoning**: Strict `fs.existsSync` validation prevents memory pollution from hallucinated paths.
- **Explicit Injection**: Use `store_memory` to deliberately persist architectural decisions, research findings, or task summaries across sessions.

---

## Reliability & Verification

Maintainers can verify header extraction and router scoring logic using provided scripts:

```bash
# Verify how specific providers return rate-limit headers (live test)
npx tsx scripts/verify-header-extraction.ts

# Verify the router's TokenFactor scoring logic against mock states
npx tsx scripts/token-factor-smoke-test.ts
```

---

## Directory Structure

```
mcp-server/
├── src/
│   ├── mcp/index.ts          # Tool registration and MCP handler
│   ├── tools/                # Seven public tool implementations
│   │   ├── use-free-llm.ts
│   │   ├── list-models.ts
│   │   ├── get-token-stats.ts
│   │   ├── validate-provider.ts
│   │   ├── code-mode.ts
│   │   ├── manage-memory.ts
│   │   └── store-memory.ts
│   ├── sandbox/              # Sandboxed code execution (QuickJS, Python)
│   ├── middleware/           # Pipeline middleware stages
│   │   └── agentic/          # Task decomposition + research validation
│   ├── pipeline/             # PipelineExecutor and Middleware interfaces
│   ├── providers/            # LLM provider implementations (15+ providers)
│   ├── memory/               # Persistent workspace memory
│   ├── cache/                # LRU + disk response cache
│   └── config/               # Environment and system configuration
├── docs/
│   ├── guide.md              # Architecture and routing details
│   ├── mcp-development.md    # Extension guide
│   ├── skill/                # Agent skill references and test cases
│   └── setup.md              # Initial setup guide
├── dashboard/                # Web dashboard (token stats, model list)
├── tests/                    # Vitest test suite
└── docker-compose.yml        # Container deployment
```
