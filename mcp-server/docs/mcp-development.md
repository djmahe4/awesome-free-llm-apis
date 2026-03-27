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

## Internal Workflow

1.  **Request Arrival**: A tool call is received via the `StdioServerTransport`.
2.  **Tool Dispatched**: The MCP server identifies the tool in `src/mcp/index.ts`.
3.  **Routing**: For LLM tools, the `Router` chooses the best provider based on availability and priority.
4.  **Cache Check**: Before calling an API, the `ResponseCache` is checked.
5.  **API Execution**: The selected Provider makes a secure fetch request using its configured API key.
6.  **Response Handling**: The result is cached, stored in the `MemoryManager`, and returned to the client.
