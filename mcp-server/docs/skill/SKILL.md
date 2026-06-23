---
name: free-llms
description: "Orchestrate multiple free LLM providers, manage persistent workspace memory, and utilize keyword-based steering for project-specific reference extraction."
metadata:
  category: utility
  triggers: free models, llm cost, fallback, routing, token tracking, workspace memory, context-aware steering, reference extractor, keyword classification, project discovery, gemini, groq, cohere, cloudflare, deepseek, qwen, compression
---

# Free LLM APIs — Usage Guide

Discipline for orchestrating multiple free LLM providers via the `@mcp:free-llm-apis` MCP server.

> **79 models** across **15 providers** — optimized for FREE-first routing.

---

## 🎯 When to Use

- **Cost-Effective Inference**: Use free frontier or mid-tier models instead of paid APIs.
- **Resilient Workflows**: Automatic fallback ensures completion even during rate limits.
- **Stateful Context**: Persist findings or decisions across multiple turns/sessions.
- **Architectural Steering**: Project-specific documentation or architectural maps guide implementation.

---

## ⚡ Quick Routing Reference

| Use Case | Model | Provider | Notes |
|----------|-------|----------|-------|
| Fast Chat | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | `cloudflare` | 100% success, ~1300ms ⚡ |
| Fast Coding | `@cf/qwen/qwq-32b` | `cloudflare` | Reasoning-focused, FREE ⚡ |
| Code Gen | `qwen/qwen3-coder-480b-a35b:free` | `openrouter` | 480B coder, FREE |
| Deep Reasoning | `DeepSeek-R1` | `huggingface` / `kluster` | Chain-of-thought |
| Bulk Tasks | `Qwen/Qwen2.5-72B-Instruct` | `siliconflow` | 1,000 RPM — best for bulk |
| High-Tier Reasoning | `Qwen/Qwen3-235B-A22B` | `nvidia` | Frontier free tier |

> **v1.0.6 Update**: NVIDIA NIM (Qwen3 235B) for Coding. SiliconFlow (1000 RPM) for Search/Summarization/Extraction. Gemma 3 for Moderation/Classification.

---

## 🛠️ Tool Reference

### `use_free_llm`
Perform chat completion with optional fallback and workspace memory.

> [!IMPORTANT]
> **MANDATORY PROJECT RULE**: For any workspace task, you MUST set `"agentic": true` AND provide `"workspace_root"`. This enables session memory and grounding.

**Example:**
```json
{
  "messages": [{ "role": "user", "content": "Implement auth in auth.ts" }],
  "agentic": true,
  "workspace_root": "c:/Users/mahes/project"
}
```

**Key Parameters:**
- `keywords`: Explicit steering (e.g. `["api", "sql"]`). Bypasses fuzzy matching and forces specific documentation sections.
- `google_search`: Enable Google Search (Gemini models only).

#### 📁 Advanced Context Steering
The pipeline automatically injects project structure and file snippets:
- **Directory Structural Awareness**: A 2-level directory tree is injected to help the LLM understand project layout.
- **Precision Quoting**: Use `"double quotes"` around technical terms in your prompt (e.g., `"computer_networks"`) to force exact `grep` extraction.
- **Gitignore Bypass**: If a required directory is gitignored (e.g., `data/`), include the keyword `override` or `gitignored` in your prompt to bypass the restriction safely.

---

### `manage_memory`
Manage persistent, workspace-aware memory across sessions.
- `search`: Find prior decisions or research findings.
- `clear`: Flush all cached memory for a workspace.

> **Rule:** Always `search` memory before starting any new research task to avoid redundant work.

---

### `store_workspace_skill`
Explicitly save structured knowledge and scripts into the workspace.
- `name`: Lowercase-hyphenated skill name.
- `what`: List of key decisions or implementation details.

> **Rule: Always call this upon task completion.** This ensures high-fidelity recall in future sessions.

---

### `index_workspace`
Proactively index all relevant files in the workspace for semantic search.
- **Rule:** Run this after significant code changes to keep the "source of truth" fresh.

---

### Other Utility Tools
- `load_skill_prompt`: Dynamically load or search for skill prompts from the antigravity skills index (search returns names and descriptions).
- `get_token_stats`: Check consumption.
- `validate_provider`: Health check.

---

## 📚 Deep Dives & References

For more detailed information on the inner workings or specific use cases, refer to the following documentation:

- [**System Architecture**](references/architecture.md): Deep dive into grounding protocols, steering engine mechanics, and advanced agentic patterns.
- [**Memory Usage Guide**](references/memory-usage.md): Architectural details of the persistent memory system and search optimization.
- [**Documentation Maintainer**](references/doc-maintainer.md): Context-aware best practices, docstring formats, and export guidelines to optimize semantic profiling.
- [**Tool Usage Matrix**](references/usages.md): Full test matrix with actual responses, token counts, and latency measurements for all tools.

---

## 🦾 Steering Keywords

| Category | Keywords | Impact |
|----------|----------|--------|
| **API/REST** | `api`, `endpoint`, `url`, `rest` | Prioritizes API documentation |
| **Persistence**| `database`, `sql`, `cache` | Prioritizes DB/Redis schemas |
| **Security** | `auth`, `jwt`, `token` | Prioritizes security protocols |
| **DevOps** | `git`, `env`, `deploy` | Prioritizes config/CI/CD maps |
| **Research** | `search`, `knowledge` | Activates deep-search optimization |
| **Bypass** | `override`, `gitignored` | Bypasses .gitignore for extraction |
| **Precision** | `"quoted term"` | Forces exact grep token extraction |
| **File Pinning** | `"filename.ext"` | Pins context to that exact file only — **use when multiple files of the same type exist** |

---

## 🔴 Usage Rules (Anti-Rationalization)

- **NEVER** use `use_free_llm` for project work without `agentic: true` and `workspace_root`.
- **NEVER** conclude a significant task without calling `store_workspace_skill`.
- **ALWAYS** check `manage_memory` for prior findings before starting research.
- **ALWAYS** run `index_workspace` when starting a new session to ground semantic memory.
- **ALWAYS** use `keywords` to strictly control injected context and save tokens.

---

## 🚨 Anti-Hallucination: Grounding to a Specific File

When a workspace contains **multiple files of the same type** (e.g., several `.json` workflow files, multiple SQL migration files), the steering engine may pull fragments from all of them and cause hallucination.

**RULE — ALWAYS QUOTE THE EXACT FILENAME when the question is about a specific file:**

```json
{
  "messages": [{ "role": "user", "content": "In \"daily-nday-pipeline.import.json\", does the Split in Batches node (typeVersion: 3) have a splitBy parameter?" }],
  "keywords": ["daily-nday-pipeline.import.json", "splitInBatches"],
  "agentic": true,
  "workspace_root": "c:/path/to/project"
}
```

- The quoted filename in the `content` triggers exact `grep` extraction from **only that file**.
- The same filename in `keywords` ensures the steering engine also prioritizes it in semantic search.
- **NEVER** send generic keywords like `n8n` or `workflow` alone when multiple workflow files exist — always add the exact filename.

> **After resolving any finding, ALWAYS call `store_workspace_skill`** to persist the answer. If you skip this, the next session will re-hallucinate the same question.

---

> [!NOTE]
> The server handles internal grounding and task decomposition automatically. Focus on providing accurate `workspace_root` paths, **quoted filenames** for file-specific queries, and using `file:///` URIs in your messages.
