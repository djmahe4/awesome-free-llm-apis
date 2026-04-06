# MCP Server Agentic Benchmarks

This directory contains the benchmarking suite for measuring the efficiency and performance of the Agentic Middleware and the `code_mode` sandbox.

## Overview

Unlike static JSON parsing benchmarks, this suite measures the real-world efficiency of intelligent subsystems:
1.  **Context Compression**: How effectively the `ContextManager` summarizes history.
2.  **Prompt Intelligence**: Level of precision in architectural reference injection.
3.  **Extraction Performance**: The speed and token savings of sandboxed extraction versus pure LLM generation.

> [!TIP]
> See [**`SAMPLES.md`**](SAMPLES.md) for actual input/output prompts and qualitative "intelligence" traces.

## Evaluation Criteria

| Metric | Calculation | Purpose |
| :--- | :--- | :--- |
| **Token Efficiency** | `Output Tokens / Input Tokens` | Measures the density of information delivered to the model. |
| **Context Savings** | `(1 - Efficiency) * 100` | The percentage of the context window freed for actual task execution. |
| **Execution Latency** | `Time (ms)` | Measures the overhead of the middleware/sandbox pipeline. |

---

## Scenario 1: Intelligent Prompt Injection

Benchmarking the `getIntelligentSystemPrompt` pipeline which parses the `external/agent-prompt/README.md` and injects specific architectural guidelines based on the user's query.

-   **Input**: The full `README.md` (Variable size, typically ~2,500+ tokens).
-   **Operation**: Keyword density scoring and level-based section extraction.
-   **Output**: A concentrated system prompt containing only the necessary references.
-   **Typical Savings**: **~90-95%**.

## Scenario 2: Memory Compression (Sliding Window)

Measures the `ContextManager.slidingWindow` strategy which compresses historical messages into a single semantic summary.

-   **Input**: 150+ historical messages (~3,500+ tokens).
-   **Operation**: LLM-based summarization of old context + verbatim retention of recent messages.
-   **Output**: A concise context block injected into the system message.
-   **Typical Savings**: **~95%**.

## Scenario 3: Sandbox Extraction (`code_mode`)

Validates the speed and accuracy of the `QuickJS` sandbox when extracting structured data from verbose LLM outputs.

-   **Input**: Raw JSON string containing chat history and multiple code blocks.
-   **Operation**: JavaScript regex extraction within a secure sandbox environment.
-   **Output**: Clean, executable code snippets and critical data points.
-   **Typical Speed**: **~100x faster** than LLM-based parsing.

---

## Running Benchmarks

Ensure you have your environment variables configured (some benchmarks trigger real LLM calls for summarization).

```bash
cd mcp-server
npx vitest bench benchmarks/code-mode.bench.ts
```

### Rate Limit Guard
Benchmarks include an automated **10-30 second delay** between scenarios to respect provider rate limits (RPM/TPM).
