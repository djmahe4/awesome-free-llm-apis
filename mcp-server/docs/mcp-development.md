# MCP Server Development Guide

This guide provides a structured overview of the MCP server architecture and explains how to extend it with new tools and providers.

## Table of Contents
- [Adding New Tools](#adding-new-tools)
- [Adding New Providers](#adding-new-providers)
- [Configuration System](#configuration-system)
- [Caching Mechanism](#caching-mechanism)
- [Sandboxed Execution (Code Mode)](#sandboxed-execution-code-mode)
- [Internal Workflow](#internal-workflow)
- [Agentic Middleware](#agentic-middleware)

---

## Adding New Tools

To add a new tool to the MCP server, follow these steps:

### 1. Implement the Tool
Create a file in `src/tools/` (e.g., `src/tools/my-tool.ts`).

```typescript
export interface MyToolInput {
  text: string;
}

export async function myTool(input: MyToolInput) {
  return { result: `Processed: ${input.text}` };
}
```

### 2. Export the Tool
Export the function and types in `src/tools/index.ts`.

### 3. Register in MCP Server
Update `src/mcp/index.ts`:
- Add the definition to the `ListToolsRequestSchema` handler.
- Add the execution logic to the `CallToolRequestSchema` handler.

---

## Adding New Providers

Providers handle the actual LLM API calls. All providers inherit from `BaseProvider`.

### 1. Create Provider Class
Create a file in `src/providers/` (e.g., `src/providers/new-provider.ts`).

```typescript
import { BaseProvider } from './base.js';

export class NewProvider extends BaseProvider {
  name = 'New AI';
  id = 'new-ai';
  baseURL = 'https://api.newai.com/v1/';
  envVar = 'NEW_AI_API_KEY';
  models = [{ id: 'model-1', name: 'Model 1' }];
  rateLimits = { rpm: 10, rpd: 500 };
}
```

### 2. Register Provider
Add your provider to the `ProviderRegistry` in `src/providers/registry.ts`.

```typescript
// src/providers/registry.ts
import { NewProvider } from './new-provider.js';

// Inside the constructor
const allProviders: Provider[] = [
  // ... existing providers
  new NewProvider(),
];
```

---

## Configuration System

The configuration is centralized in `src/config/index.ts`. It manages:
- **Environment Variables**: API keys and tokens are pulled from `process.env`.
- **System Settings**: Port, log level, and data storage paths.

To add a new API key, add it to the `providers` object in `src/config/index.ts` and ensure it's documented in `.env.example`.

---

## Caching Mechanism

The `ResponseCache` (`src/cache/index.ts`) uses an LRU (Least Recently Used) cache to store LLM responses, providing both speed and cost-efficiency.

### Key Features
- **Workspace Awareness**: Cache keys are contextually aware of the project identity. A `WorkspaceScanner` generates a stable **Identity Hash** based on the absolute path of the workspace root.
- **Persistence**: Responses are persisted to `data/cache.json`. This allows the server to maintain its cache across restarts.
- **Stable Identity**: Unlike transient content hashes, the Identity Hash remains constant even as you edit code, ensuring your stored facts and cached responses persist throughout the development lifecycle.

### Implementation Details
The `WorkspaceScanner` uses `fs.existsSync` to validate that the provided `workspace_root` physically exists on disk, preventing "workspace poisoning" from hallucinated paths.

```typescript
const wsHash = workspaceScanner.getWorkspaceHash(workspaceRoot);
const cacheKey = cache.generateKey(request, wsHash);
const cachedResponse = cache.get(cacheKey);
```

---

## Sandboxed Execution (Code Mode)

The `code_mode` tool executes code using isolated sandbox runtimes with no filesystem or network access.

### Supported Languages

| Language | Sandbox | Notes |
|----------|---------|-------|
| `javascript` (default) | QuickJS via `quickjs-emscripten` | Fully sandboxed; no external deps |
| `python` | Restricted subprocess with safe builtins | Requires Python 3 on PATH and RestrictedPython installed |
| `go` | Implemented using `goja` | Fully sandboxed; no external deps |
| `rust` | Implemented using `boa_engine` | Fully sandboxed; no external deps |

### Security Features (all languages)
- **No filesystem access**: Scripts cannot read or write files
- **No network access**: Scripts cannot make HTTP requests or open sockets
- **No process/OS calls**: Scripts cannot spawn processes or access environment beyond `DATA`
- **Timeouts**: Execution is interrupted if it exceeds `timeoutMs` (default 5000ms)
- **Output isolation**: Only `stdout` (from `print()` / `console.log()`) is returned to the caller

### JavaScript Executor (QuickJS)
The `executeJavaScript` function in `src/sandbox/executor.ts` manages:
1. Initializing a fresh QuickJS context per request
2. Setting up stdout/stderr capturing via `print()` and `console.log()`
3. Injecting the `DATA` variable as a string global
4. Setting a deadline-based interrupt handler for the timeout
5. Disposing the context after execution (no state leakage between calls)

```typescript
// JavaScript sandbox globals available to user code:
// DATA: string  — the input data passed in the `data` parameter
// print(...args): void  — writes to stdout (same as console.log)
// console.log(...args): void  — writes to stdout
// console.error(...args): void  — writes to stderr
```

### Python Executor
The `executePython` function in `src/sandbox/executor.ts` manages:
1. Building a wrapper script that restricts builtins to a safe allowlist
2. Injecting `DATA` via the `__SANDBOX_DATA__` environment variable
3. Running the user code via `python3 -c <wrapper>` as a subprocess
4. Capturing stdout/stderr with a 1MB buffer limit
5. Handling timeouts via Node.js `execFile` timeout

```python
# Python sandbox — available built-ins (safe allowlist):
# DATA: str  — the input data string
# print(), len(), range(), enumerate(), zip(), map(), filter()
# sorted(), reversed(), list(), dict(), set(), tuple()
# str(), int(), float(), bool(), bytes()
# max(), min(), sum(), abs(), round()
# json module is importable via __import__('json')
# datetime module is importable via __import__('datetime')
```

### Adding a New Language Sandbox

To add support for a new language (e.g., Go via `goja`):

1. Add the language to the `SandboxLanguage` type in `src/sandbox/executor.ts`
2. Implement an `executeGo(code, data, timeoutMs)` function following the same pattern as `executeJavaScript`
3. Add a case in the `executeInSandbox` switch statement
4. Update the `code_mode` tool description in `src/mcp/index.ts` to include the new language in the `language` enum
5. Update `docs/mcp-development.md` and `docs/skill/SKILL.md` tables

---

## Workspace Awareness

The MCP server is "space-aware," meaning it can scan the caller's specific workspace to generate a contextual state hash. This hash ensures that caching and memory are unique to the project you are currently working on.

### Workspace Scanning
Use the `workspace_root` parameter in tool calls to specify the directory to scan. The `WorkspaceScanner` will:
- Generate a stable SHA-256 **Identity Hash** built strictly from the absolute directory path.
- Detect and reject non-existent paths via `fs.existsSync` validation.
- Guarantee memory stability: your architectural decisions and context persist even if you modify tool source code or configuration files.

### Key Logic
```typescript
const wsHash = workspaceScanner.getWorkspaceHash(workspaceRoot);
// This hash remains stable throughout the life of the project directory.
```

---

## Memory Management Tool

The `manage_memory` tool provides a way to interact with the persistent memory system programmatically.

### Actions
- **search**: Retrieve past interactions or manual context for the workspace.
- **list**: List workspace identifiers and physical path hashes.
- **stats**: View compression and usage statistics.
- **clear**: Wipe memory for a specific workspace namespace.

---

## Explicit Memory Injection

The `store_memory` tool allows agents to deliberately inject facts into the long-term store. This is the primary mechanism for preserving architectural decisions across sessions.

### Usage Example
```json
{
  "name": "store_memory",
  "arguments": {
    "key": "queue_strategy",
    "content": "Using BullMQ on Redis for high-throughput job isolation.",
    "workspace_root": "/home/user/project-a"
  }
}
```

---

## Middleware Pipeline Architecture

The system uses a flexible, Starlette-inspired middleware pipeline to handle LLM requests. This allows for clean separation of concerns like caching, routing, and token management.

### Key Components
- **PipelineExecutor**: Manages the chain of middlewares and the execution context.
- **Middleware Interface**: Every middleware must implement an `execute(context, next)` method.
- **PipelineContext**: A shared object that carries the request, response, and metadata (like estimated tokens or selected provider) through the stack.

### Default Pipeline Stack
1.  **ResponseCacheMiddleware**: Checks if a result exists in the persistent workspace-aware cache.
2.  **AgenticMiddleware (Conditional)**: If triggered, decomposes tasks into sub-problems and prepares the context with intelligent prompts.
3.  **IntelligentRouterMiddleware**: Maps the task type to a prioritized list of models and handles failover.
4.  **TokenManagerMiddleware**: Performs local token estimation and synchronizes quotas from API headers.
5.  **LLMExecutionMiddleware**: Performs the final HTTPS request to the provider.

---

## Agentic Middleware

The `AgenticMiddleware` (`src/middleware/agentic/agentic-middleware.ts`) provides high-level reasoning and task decomposition capabilities.

### Trigger Logic
The middleware operates in three modes:
- **Global**: Enabled via `ENABLE_AGENTIC_MIDDLEWARE=true` in `.env`.
- **Selective**: Trigged per-request by setting `agentic: true` in the context or request body.
- **Bypass**: If no `sessionId` is available (either provided by the client or derived from a `workspace_root`, see below), the middleware automatically steps out of the pipeline.

### Foolproof Session ID Derivation
To provide a zero-config experience, the `useFreeLLM` tool automatically derives a deterministic `sessionId` if a `workspace_root` is provided but an explicit ID is missing.
- **Precedence**: Client Override > Workspace Hash > None (Bypass).
- **Format**: `ws-[sha256(path.resolve(workspaceRoot).replace(/\\/g, '/'))]`.
- **Namespace**: The `ws-` prefix ensures these auto-generated IDs do not collide with manually provided strings.

### Strict Session Enforcement
To prevent data leakage and disk pollution, every agentic request **must** have an associated `sessionId`.
- **Security**: Ensures that logs, memory, and intermediate state are strictly partitioned by project.
- **Integrity**: Prevents "anonymous" agentic execution that could lead to untracked directory creation.

### Dynamic Prompt Synchronization
The `prompt.json` engine uses a non-blocking, asynchronous loading strategy with automatic cache invalidation.
- **Efficiency**: Uses `fs.stat()` to check `mtime` before every use.
- **Zero Restart**: Prompt updates are picked up instantly without requiring a server restart.
- **Asynchronous**: Built entirely on `fs.promises` to keep the event loop free.

---

## Adding New Middleware

To extend the request life cycle, you can add new middleware components.

### 1. Implement Middleware
Create a class in `src/pipeline/middlewares/` that implements the `Middleware` interface.

```typescript
import { Middleware, PipelineContext, NextFunction } from '../middleware.js';

export class LoggingMiddleware implements Middleware {
  name = 'LoggingMiddleware';
  async execute(context: PipelineContext, next: NextFunction): Promise<void> {
    console.log(`Executing request for: ${context.request.model}`);
    await next(); // Pass to the next middleware
    console.log('Request completed');
  }
}
```

### 3. Best Practices: Non-Blocking I/O
**CRITICAL**: Never perform synchronous file I/O or heavy computations at the module level (during import) or within a middleware without `await`. 

- **Avoid Sync I/O**: Use `fs.promises` instead of `fs.readFileSync`.
- **Memoization**: Cache expensive operations (like prompt loading) after the first execution to ensure subsequent requests are fast.
- **Async Factories**: Prefer async functions that return values over module-level constants that require immediate initialization.

### 2. Register Middleware
Update the tool implementation (e.g., `src/tools/use-free-llm.ts`) to include your middleware in the `PipelineExecutor` constructor.

---

## Internal Workflow

1.  **Request Arrival**: A tool call (e.g., `use_free_llm`) is received via Unified HTTP/SSE (using `StreamableHTTPServerTransport`) or Stdio.
2.  **Pipeline Initialization**: The tool creates a `PipelineExecutor` with the standard stack. If enabled via the **Dual-Mode Trigger** (global `.env` or per-request `agentic: true` flag), the **Agentic Middleware** is prepended to the chain.
3.  **Middleware Chain**:
    - **Agentic (Optional)**: Performs task decomposition and awaits dynamic/async prompt injection.
    - **Cache**: Immediate return if a match is found.
    - **Router**: Selects the best available model (ignoring placeholder keys).
    - **Token Manager**: Ensures the request won't exceed remaining quotas.
    - **Execution**: Performs the API call and captures response headers.
4.  **Drift Correction**: The Token Manager updates the ground truth quota using `x-ratelimit-*` headers.
5.  **Response**: The final result is returned to the client and stored in long-term memory.
