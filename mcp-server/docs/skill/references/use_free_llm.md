# `use_free_llm`

**Purpose:** Send conversational, reasoning, or coding requests to free AI models with automatic provider fallback, rate-limit recovery, and agentic workspace grounding.

---

## 🎯 When to Use
- **Conversational Queries & Code Generation**: Standard multi-turn chat and coding assistance.
- **Agentic Planning & Multi-Step Execution**: Breaking complex goals into subtasks with full workspace memory grounding.
- **Background Task Control**: Monitoring or resuming ongoing autonomous runs without blocking clients or timing out.
- **Grounded Reference Retrieval**: Automatically reading local code files, `.pdf` pages, and image attachments.

---

## 📋 Full Parameter Reference

| Parameter | Type | Required | Description |
|---|---|---|---|
| `messages` | `Array<{role: string, content: string | Array}>` | **Yes** | OpenAI-compatible message history. |
| `model` | `string` | No | Explicit model override (e.g., `gemini-2.5-flash`, `deepseek-r1`, `qwen3-coder`). Defaults to auto-routing. |
| `workspace_root` | `string` | No | Absolute path to the active codebase. Enables workspace context and memory. |
| `agentic` | `boolean` | No | Activates task decomposition, subtask planning, and iterative reasoning. |
| `sessionId` | `string` | No | Unique session key to maintain conversational continuity and memory. Defaults to `ws-<hash>` if `workspace_root` is provided. |
| `action` | `'run' | 'continue' | 'status' | 'abort'` | No | **Background execution & control action**. Defaults to `'run'`. |
| `resume_input` | `string` | No | Context / instructions appended when resuming a paused task via `action: 'continue'`. |
| `skipIndexing` | `boolean` | No | Skips pre-emptive full workspace re-indexing. Recommended for fast single-file queries. |
| `keywords` | `string[]` | No | Semantic keywords prioritizing specific reference documents or memory items. |
| `skill` | `string` | No | Name of a specialized skill to load before executing (e.g. `tdd-workflow`, `api-patterns`). |
| `google_search` | `boolean` | No | Triggers automated web grounding via search provider cascade. |

---

## ⚡ Background Execution & Subcommands

When executing long-running agentic tasks, `use_free_llm` provides non-blocking lifecycle controls:

### 1. Check Background Run Status (`action: 'status'`)
Check if a background agentic run is active, paused, or completed for a session without invoking any LLM provider:
```json
{
  "messages": [],
  "sessionId": "ws-a1b2c3d4e5f60718",
  "action": "status"
}
```
*Returns instantaneous JSON summary of completed vs queued subtasks.*

### 2. Resume a Paused Task (`action: 'continue'`)
Resume an agentic run that was paused for user input or rate-limiting:
```json
{
  "messages": [],
  "sessionId": "ws-a1b2c3d4e5f60718",
  "action": "continue",
  "resume_input": "Approved. Proceed with writing the unit tests."
}
```

### 3. Cancel / Abort Background Job (`action: 'abort'`)
Instantly cancel an in-progress autonomous run:
```json
{
  "messages": [],
  "sessionId": "ws-a1b2c3d4e5f60718",
  "action": "abort"
}
```

---

## 🛠️ Practical Invocation Examples

### Standard Grounded Coding Request
```json
{
  "messages": [{ "role": "user", "content": "Refactor error handling in src/server.ts" }],
  "workspace_root": "C:/Projects/my-app",
  "agentic": true,
  "keywords": ["express", "middleware"]
}
```

### Fast Single-File Query with Image Attachment
```json
{
  "messages": [
    {
      "role": "user",
      "content": "Explain the architecture diagram in file:///C:/Projects/my-app/architecture.png"
    }
  ],
  "skipIndexing": true
}
```

