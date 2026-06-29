# MCP Server Development Guide
 
This guide provides a structured overview of how to extend the `free-llm-apis` MCP server with new tools, providers, models, or custom middlewares.
 
## Table of Contents
- [Adding New Tools](#adding-new-tools)
- [Adding New Providers](#adding-new-providers)
- [Adding New Models](#adding-new-models)
- [Updating the Text Router](#updating-the-text-router)
- [Extending the Request Lifecycle (Adding Middlewares)](#extending-the-request-lifecycle-adding-middlewares)
- [Best Practices: Non-Blocking I/O](#best-practices-non-blocking-io)
- [Architectural References](#architectural-references)
 
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
  models = [{ id: 'model-1', name: 'Model 1', contextWindow: 8192 }];
  rateLimits = { rpm: 10, rpd: 500 };
}
```
 
### 2. Register Provider
Add your provider to the `ProviderRegistry` in [registry.ts](../src/providers/registry.ts).
 
```typescript
import { NewProvider } from './new-provider.js';
 
// Inside the constructor
const allProviders: Provider[] = [
  // ... existing providers
  new NewProvider(),
];
```
 
---
 
## Adding New Models
 
To add new models to an existing or new provider:
 
1. **Define the Model**: Open [models.ts](file:///c:/Users/mahes/OneDrive/Desktop/Python-Projects/awesome-free-llm-apis/mcp-server/src/config/models.ts) (or your custom provider file) and add the model definition to the provider's `models` array:
   ```typescript
   { id: 'provider/model-name:free', name: 'Model Name', contextWindow: 131072 }
   ```
2. **Assign Capability Score**:
   - Every model has a `capability` score ranging from `0.0` to `1.0` defined in the `MODEL_METADATA` map in `models.ts`.
   - The frontier reasoning model **`deepseek/deepseek-r1` (at `1.0`) is the baseline** for maximum reasoning capability. All other models are scored proportionally relative to this baseline (e.g., `nvidia/nemotron-3-ultra-550b-a55b` is scored at `0.88`).
3. **Classify the Model**:
   - If the model is a **reasoning/thinking** model, ensure it is registered or mapped in [TextRouterMiddleware.ts](../src/pipeline/middlewares/TextRouterMiddleware.ts) under the reasoning capabilities map so the router knows to use it for planning and subtask decomposition.
   - If it is a **coding** model, ensure it is added to the coding capability list.
 
---
 
## Updating the Text Router
 
The [TextRouterMiddleware.ts](../src/pipeline/middlewares/TextRouterMiddleware.ts) manages task-based model selection and quantum scoring.
- **Task Weights**: To adjust how tasks are classified, update the `keywordTaskMap` in `TextRouterMiddleware.ts` or add new keywords to influence the classification weight.
- **Model Scoring**: If a new model requires a custom capability multiplier (e.g., prioritizing it for search or coding), update the scoring logic inside the `scoreModelForTask` method.
 
---
 
## Extending the Request Lifecycle (Adding Middlewares)
 
To extend or modify the request lifecycle, you can add a new middleware component.
 
### 1. Implement the Middleware
Create a class in `src/pipeline/middlewares/` that implements the `Middleware` interface:
 
```typescript
import { Middleware, PipelineContext, NextFunction } from '../middleware.js';
 
export class LoggingMiddleware implements Middleware {
  name = 'LoggingMiddleware';
  async execute(context: PipelineContext, next: NextFunction): Promise<void> {
    console.log(`Executing request for: ${context.request.model}`);
    await next(); // Pass control to the next middleware in the chain
    console.log('Request completed');
  }
}
```
 
### 2. Register the Middleware
Register your new middleware by adding it to the `PipelineExecutor` instantiation inside [instances.ts](../src/pipeline/instances.ts).
 
### 3. Best Practices: Non-Blocking I/O
**CRITICAL**: Never perform synchronous file I/O or heavy computations at the module level (during import) or within a middleware without `await`.
- **Avoid Sync I/O**: Use `fs.promises` instead of `fs.readFileSync`.
- **Memoization**: Cache expensive operations (like prompt loading) after the first execution to ensure subsequent requests remain fast.
- **Async Factories**: Prefer async functions that return values over module-level constants that require immediate initialization.
 
---
 
## 📖 Architectural References
 
To avoid documentation drift, refer to the following single sources of truth:
- For the full request lifecycle and routing design, see the [Workflow & Architecture Guide](guide.md).
- For details on workspace-aware memory, caching, and ADR extraction, see the [Memory Usage Guide](references/memory-usage.md).
- For prompt scoring and dynamic injection, see the [Agentic Prompt Injection Guide](agentic-prompts.md).
