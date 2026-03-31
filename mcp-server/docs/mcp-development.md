# MCP Server Development Guide

This guide provides a structured overview of the MCP server architecture and explains how to extend it with new tools and providers.

## Table of Contents
- [Adding New Tools](#adding-new-tools)
- [Adding New Providers](#adding-new-providers)
- [Configuration System](#configuration-system)
- [Caching Mechanism](#caching-mechanism)
- [Sandboxed Execution (Code Mode)](#sandboxed-execution-code-mode)
- [Internal Workflow](#internal-workflow)

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
- **Workspace Awareness**: Cache keys are contextually aware of the codebase state. A `WorkspaceScanner` generates a content hash of `src/tools` and `src/providers`. If any logic changes, the cache for those contexts is automatically invalidated.
- **Persistence**: Responses are persisted to `data/cache.json`. This allows the server to maintain its cache across restarts.
- **Memory Efficiency**: Uses `lru-cache` to keep only the hottest entries in RAM while offloading the full set to disk.

### Implementation Details
The `WorkspaceScanner` avoids high RAM usage by hashing file metadata (name, size, mtime) rather than full content, which is sufficient for detecting changes in most development workflows.

```typescript
const wsHash = workspaceScanner.getWorkspaceHash();
const cacheKey = cache.generateKey(request, wsHash);
const cachedResponse = cache.get(cacheKey);
```

---

## Sandboxed Execution (Code Mode)

The `code_mode` tool executes arbitrary JavaScript using the **QuickJS** engine via `quickjs-emscripten`.

### Security Features
- **Isolated Context**: Each execution runs in a fresh QuickJS context.
- **Timeouts**: Execution is interrupted if it exceeds the specified `timeoutMs` (default 5000ms).
- **Global Constraints**: Only a few globals like `DATA` (input string), `print()`, and `console.log()` are exposed.

### Executor Logic
The `executeInSandbox` function in `src/sandbox/executor.ts` manages:
1.  Initializing the QuickJS runtime.
2.  Setting up stdout/stderr capturing.
3.  Injecting the `DATA` variable.
4.  Handling errors and timeout interrupts.

---

## Workspace Awareness

The MCP server is "space-aware," meaning it can scan the caller's specific workspace to generate a contextual state hash. This hash ensures that caching and memory are unique to the project you are currently working on.

### Workspace Scanning
Use the `workspace_root` parameter in tool calls (e.g., `use_free_llm`) to specify the directory to scan. The `WorkspaceScanner` will:
- Generate a SHA-256 hash based on file names, sizes, and modification times.
- Detect changes in `src/tools`, `src/providers`, and root configuration files.
- Automatically invalidate cached responses if the workspace state changes.

### Key Logic
```typescript
const wsHash = workspaceScanner.getWorkspaceHash(workspaceRoot);
// Included in cache keys and memory metadata
```

---

## Memory Management Tool

The `manage_memory` tool provides a way to interact with the persistent memory system programmatically.

### Actions
- **search**: Retrieve past interactions for the current workspace.
- **list**: List workspace identifiers.
- **stats**: View compression and usage statistics.
- **clear**: Wipe memory for a specific workspace.

### Usage Example
```json
{
  "name": "manage_memory",
  "arguments": {
    "action": "search",
    "workspace_root": "/home/user/project-a",
    "query": "authentication"
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
2.  **IntelligentRouterMiddleware**: Maps the task type to a prioritized list of models and handles failover.
3.  **TokenManagerMiddleware**: Performs local token estimation and synchronizes quotas from API headers.
4.  **LLMExecutionMiddleware**: Performs the final HTTPS request to the provider.

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
