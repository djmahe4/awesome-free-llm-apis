# 🧪 `free-llm-apis` MCP Server — Test Case Usages

**Tested On:** 2026-06-28 | **Server:** `@mcp:free-llm-apis`  
**Total Models:** 70+ across 14 providers (fully active, Kluster removed)

---

## Overview of Tools

| Tool | Purpose | Required Params | Key Optional Params |
| :--- | :--- | :--- | :--- |
| `get_token_stats` | Retrieve real-time usage (tokens/requests) per provider | *(none)* | — |
| `validate_provider` | Health-check and credential validation for a provider | `providerId` | — |
| `use_free_llm` | Send chat messages to any model with fallback support | `messages` | `model`, `keywords`, `agentic`, `workspace_root` |
| `execute_skill` | Execute a prompt grounded in a local skill and its references | `skill`, `input` | `model`, `workspace_root` |
| `vision_tool` | Analyze local images via a vision-capable model | `image_path` | `prompt`, `model` |
| `manage_memory` | Manage persistent workspace memory (search/list/stats/clear) | `action` | `workspace_root`, `query`, `limit` |
| `store_workspace_skill` | Harvest structured knowledge into the workspace | `name`, `description`, `what` | `workspace_root`, `why`, `files` |
| `index_workspace` | Index workspace files for semantic search | `workspace_root` | `force` |

---

## TC-01 — `get_token_stats`

**Purpose:** Monitor per-provider token consumption and request counts.

### Invocation
```json
{}
```

### Sample Response (Groq)
```json
{
  "id": "groq",
  "name": "Groq",
  "isAvailable": true,
  "rateLimits": { "rpm": 30, "rpd": 14400 },
  "usage": { "tokens": 1024, "requests": 2 }
}
```

---

## TC-02 — `validate_provider`

**Purpose:** Run a live health check + credential validation for a specific provider.

### Invocation
```json
{ "providerId": "groq" }
```

### Response
```json
{
  "success": true,
  "message": "Provider is online and successfully authenticated.",
  "latencyMs": "45ms"
}
```

---

## TC-03 — `use_free_llm`

**Purpose:** Send a chat completion request to any model, with optional fallback and workspace memory.

### Invocation (Project-scoped task)
```json
{
  "messages": [{ "role": "user", "content": "Implement auth in auth.ts" }],
  "agentic": true,
  "workspace_root": "/abs/path/to/project",
  "keywords": ["security", "jwt"]
}
```

### Response
- Content: `"Here is the JWT authentication implementation..."`
- Automatically injects directory structure, relevant grep snippets, and session memory context.

---

## TC-04 — `execute_skill`

**Purpose:** Run a prompt grounded in a local skill's instructions and reference files.

### Invocation
```json
{
  "skill": "ab-test-setup",
  "input": "Design an A/B test for the checkout button.",
  "workspace_root": "/abs/path/to/project"
}
```

### Response
- Resolves the `ab-test-setup` directory under `.free-llm-mcp/skills/` or the global config.
- Injects `SKILL.md` and all referenced markdown files (e.g., `references/metrics.md`) into the system prompt before calling the LLM.

---

## TC-05 — `vision_tool`

**Purpose:** Analyze local images using a vision-capable model.

### Invocation
```json
{
  "image_path": "file:///c:/Users/mahes/project/assets/login_page.png",
  "prompt": "Analyze the UI layout of this login page.",
  "workspace_root": "/abs/path/to/project"
}
```

### Response
- Resolves the local path, converts the image to base64, and routes it to an available vision model (e.g., Gemini or Llama-3.2-Vision).

---

## TC-06 — `manage_memory`

**Purpose:** Manage persistent workspace-aware memory for context across sessions.

### Invocation (Search)
```json
{
  "action": "search",
  "workspace_root": "/abs/path/to/project",
  "query": "authentication"
}
```

---

## TC-07 — `store_workspace_skill`
 
**Purpose:** Create or register a custom helper skill, debugging utility, or reference script under the workspace customizations root.
 
### Invocation
```json
{
  "name": "db-migration-helper",
  "description": "Database migration verification utility and rollback script wrapper.",
  "what": [
    "Added verify-migrations.sh script to validate DB schemas post-migration.",
    "Integrated schema diff checks before executing prisma migrate deploy."
  ],
  "why": "Prevent schema drift during rapid deployment cycles.",
  "files": ["scripts/verify-migrations.sh"],
  "workspace_root": "/abs/path/to/project"
}
```

---

## TC-08 — `index_workspace`

**Purpose:** Proactively index all relevant files in the workspace for semantic search.

### Invocation
```json
{
  "workspace_root": "/abs/path/to/project",
  "force": false
}
```

### Response
```json
{
  "totalFiles": 142,
  "indexedFiles": 142,
  "skippedFiles": 0,
  "errors": []
}
```