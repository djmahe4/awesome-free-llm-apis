---
name: free-llms
description: "Orchestrate multiple free LLM providers, manage persistent workspace memory, and utilize keyword-based steering for project-specific reference extraction."
metadata:
  category: utility
  triggers: free models, llm cost, fallback, routing, token tracking, workspace memory, context-aware steering, reference extractor, keyword classification, project discovery, gemini, groq, cohere, cloudflare, deepseek, qwen, compression, execute skill, vision tool
---

# Free LLM APIs — Usage Guide

Discipline for orchestrating multiple free LLM providers via the `@mcp:free-llm-apis` MCP server.

> **v1.0.6 Update**: Decoupled routing layers, centralized task classification, and new `execute_skill` and `vision_tool` integrations.

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
| Coding | `qwen/qwen3-coder-480b-a35b:free` | `openrouter` | 480B coder, FREE |
| Deep Reasoning | `DeepSeek-R1` | `huggingface` | Chain-of-thought |
| Bulk Tasks | `Qwen/Qwen2.5-72B-Instruct` | `siliconflow` | 1,000 RPM — best for bulk |
| High-Tier Reasoning | `Qwen/Qwen3-235B-A22B` | `nvidia` | Frontier free tier |

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

---

### `execute_skill` [NEW]
Execute a prompt using a specific local skill's instructions and reference files.

- **Parameters**:
  - `skill` (required): Name of the skill directory under `.free-llm-mcp/skills/` or the global config.
  - `input` (required): The prompt or instruction to run.
  - `model` (optional): Specific model override.
  - `workspace_root` (optional): Absolute path to the project root.
- **How it Works**: Automatically extracts relative file paths referenced in `SKILL.md` (e.g., `references/*.md`, `resources/*`), loads their contents, and injects them as system context before executing the model.

---

### `vision_tool` [NEW]
Analyze local images or remote image URLs.
- **Parameters**:
  - `image_path` (required): Absolute path or `file:///` URI to the local image.
  - `prompt` (optional): Text prompt accompanying the image.
- **How it Works**: Resolves Windows-specific paths (handling spaces and backslashes), converts the image to base64, and routes it to an available vision provider (e.g., Gemini or Llama-3.2-Vision).

---

### `manage_memory`
Manage persistent, workspace-aware memory across sessions.
- `search`: Find prior decisions or research findings.
- `clear`: Flush all cached memory for a workspace.

---

### `store_workspace_skill`
Save structured knowledge and scripts into the workspace.
- `name`: Lowercase-hyphenated skill name.
- `what`: List of key decisions or implementation details.

---

### `index_workspace`
Proactively index all relevant files in the workspace for semantic search.

---

## 📁 Advanced Context & Media Steering

### 1. PDF Page Resolution & Visual Grounding [NEW]
If you reference a PDF file path in your prompt containing a `#page=N` hash:
- **Example**: `Check the diagram in [architecture.pdf](file:///c:/project/docs/architecture.pdf#page=4)`
- **Behavior**: The server automatically uses `PyMuPDF` to render that specific page to an image, extracts its text, and passes both the **base64 image** and the **extracted text** directly to the LLM. It also auto-calculates page offsets (e.g. index vs physical pages) and caches them.

### 2. Semantic Wiki Memory & ADR Extraction [NEW]
The workspace memory maintains a structured wiki under `.free-llm-mcp/wiki/` containing episodic and semantic pages.
- **ADR Auto-Extraction**: The system automatically scans your responses for decision patterns (e.g., `"decided to"`, `"decision:"`, `"chose X over Y"`) and extracts them into structured **Architecture Decision Records (ADRs)** inside the wiki.

---

## 📚 Deep Dives & References

- [**System Architecture**](references/architecture.md): Deep dive into grounding protocols, decoupled routing mechanics, and advanced agentic patterns.
- [**Skill & Sandbox Logic**](references/code-mode-logic.md): Guide to creating custom skills for `execute_skill` and how the internal QuickJS sandbox executes code.
- [**Memory Usage Guide**](references/memory-usage.md): Architectural details of the persistent memory system, wiki structure, and PDF offset caching.
- [**Documentation Maintainer**](references/doc-maintainer.md): Context-aware best practices for codebase documentation.
- [**System Tool Usage Matrix**](references/usages.md): Full test matrix with actual responses and latency measurements.

---

## 🔍 Quick Agent Diagnostics

If a tool call fails or returns an error, follow this sequence:
1. **Verify Server Health**: Call `validate_provider` with the target provider (e.g., `gemini`, `groq`) to check connectivity.
2. **Check Token Budgets**: Call `get_token_stats` to see if a provider is rate-limited or lacks credentials.
3. **Monitor Visual Dashboard**: Inform the user they can view real-time latency and token statistics on the local dashboard at `http://localhost:3000` (if running in SSE mode).
