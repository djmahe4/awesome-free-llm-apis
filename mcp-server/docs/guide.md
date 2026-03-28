# Workflow & Architecture Guide

This guide explains the inner workings of the Intelligent LLM Orchestration Pipeline, including routing logic, token management, and middleware execution.

## 1. Orchestration Pipeline Flow

The system uses a Starlette-inspired middleware pipeline. Every request passes through a series of "layers" before reaching the LLM provider.

```mermaid
sequenceDiagram
    participant U as User / Tool Call
    participant E as PipelineExecutor
    participant C as CacheMiddleware
    participant R as RouterMiddleware
    participant T as TokenManagerMiddleware
    participant X as ExecutionMiddleware
    participant P as LLM Provider

    U->>E: execute(request, taskType)
    E->>C: Process
    C->>C: Check Memory & Disk Cache
    alt Cache Hit
        C-->>U: Return Cached Response
    else Cache Miss
        C->>R: Process
        R->>R: Map Task to Model Tier
        loop For each model in tier
            R->>T: Process
            T->>T: Interpolate Token Usage
            T->>X: Process
            X->>P: HTTPS Request
            alt Success
                P-->>X: Response + Headers
                X->>T: Sync Quota from Headers
                T-->>R: Return Response
                R-->>U: Final Result
            else Provider Error / Rate Limit
                X-->>R: Error
                R->>R: Cascade to next fallback
            end
        end
    end
```

## 2. Intelligent Routing Logic

The `IntelligentRouterMiddleware` dynamically maps abstract tasks to a prioritized list of models. If the first choice is unavailable (e.g., missing API key or rate limited), it cascades to the next best option.

```mermaid
graph TD
    A[Incoming Request] --> B{Task Type?}
    
    B -- Coding --> C[Tier: DeepSeek-R1 -> Gemini 3.1 Pro -> Qwen 2.5 Coder]
    B -- Moderation --> D[Tier: Gemma 2 -> Gemini Flash -> Nemotron]
    B -- Chat --> E[Tier: GPT-4o -> Llama 3.3 70B -> Gemini Flash]
    
    C --> F{Available?}
    D --> F
    E --> F
    
    F -- Yes --> G[Execute with Provider]
    F -- No --> H[Next in Tier]
    H --> F
    
    H -- Exhausted --> I[Error: 503 Service Unavailable]
```

## 3. Token Management & Synchronization

The pipeline maintains a local "interpolated" token count to prevent overwhelming providers and hitting hard limits.

1.  **Local Estimation**: Before a request, `js-tiktoken` estimates the input tokens.
2.  **Proactive Blocking**: If the estimated usage exceeds the remaining quota, the request is blocked or routed elsewhere.
3.  **Response Sync**: After a successful call, the `TokenManagerMiddleware` reads `x-ratelimit-remaining-tokens` (and similar headers) to update the ground truth.

```mermaid
graph LR
    A[Start Request] --> B[Estimate Tokens]
    B --> C{Within Quota?}
    C -- No --> D[Try Lower Tier / Error]
    C -- Yes --> E[Call Provider]
    E --> F[Capture Headers]
    F --> G[Update Local Quota]
    G --> H[End]
```

## 4. MCP Tools Interaction

The pipeline is exposed via the `use_free_llm` tool.

- **Request**: `{ model: string, prompt: string, task?: TaskType }`
- **Logic**: The tool initializes the `PipelineExecutor` with a standard stack of middlewares.
- **Monitoring**: Use the `get_token_stats` tool to view the current state of these quotas in real-time.
