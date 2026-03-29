# Workflow & Architecture Guide

This guide explains the inner workings of the LLM Orchestration Pipeline, including routing logic, token management, and middleware execution.

## 1. Orchestration Pipeline Flow

The system uses a middleware-based pipeline. Every request passes through a series of "layers" before reaching the LLM provider.

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

The server exposes a suite of tools for LLM interaction, discovery, and system management.

### Tool Discovery Handshake
The system follows the standard MCP lifecycle:
1.  **Initialize**: Client connects and receives capabilities. Note that `capabilities.tools` returns an empty object `{}` per spec to signal support.
2.  **List Tools**: Client calls `tools/list` to receive the full JSON schema for all available tools.

### 1. `use_free_llm`
The primary gateway to the orchestration pipeline. 

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `model` | string | Yes | The model ID (e.g., `gpt-4o`, `gemini-1.5-pro`). |
| `messages` | array | Yes | Array of role/content message objects. |
| `task` | string | No | Abstract task hint (`coding`, `chat`, `moderation`). |
| `temperature`| number | No | Sampling temperature (0.0 - 1.0). |
| `max_tokens` | number | No | Maximum tokens to generate. |
| `workspace_root`| string | No | Path to scan for local context. |

### 2. `list_available_free_models`
Discover all supported models across all providers.
- **Param**: `available_only: true` filters for providers with active API keys.

### 3. `manage_memory`
Interface for the persistent, workspace-aware semantic memory system.
- **Actions**: `search`, `list`, `stats`, `clear`.
- **Note on Architecture**: All memory is physically stored centrally in the MCP server's local `data/memory.json` file. The `workspace_root` parameter is used to generate a unique cryptographic hash, which acts as a **logical namespace** to safely isolate context between different projects.

### 4. `code_mode`
Executes arbitrary JavaScript code in a secure, sandboxed QuickJS environment. 
- **Use Case**: Processing large data sets locally without sending sensitive raw data to an LLM.

### 5. `get_token_stats` & `validate_provider`
Utility tools for monitoring system health and verifying credentials.

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

By hardening the HTTP envelope, the server guarantees that token states, memory operations, and sensitive provider credentials remain secure even when exposed to web clients or network boundaries.
