# Memory Usage Strategy — `free-llm-apis`

The server provides content-addressed, workspace-aware persistence using local JSON stores, a semantic wiki, and a PDF index cache.

---

## 🧠 Core Patterns

### 1. Workspace Fingerprinting
Always list the current workspace hash before reloading state:
```json
{ "action": "list", "workspace_root": "/absolute/path/to/workspace" }
```

### 2. Knowledge Retrieval
Search for existing context before starting any task:
```json
{ "action": "search", "query": "auth implementation patterns", "workspace_root": "/absolute/path/to/workspace" }
```

### 3. Compression Monitoring
Monitor `stats` to prevent memory bloat:
```json
{ "action": "stats", "workspace_root": "/absolute/path/to/workspace" }
```
- **Ratio < 1.0**: Efficient. Normal operation.
- **Ratio > 1.5**: Data overhead. Flatten nested structures before next write.

---

## 📖 Semantic Wiki Structure [NEW]

The server automatically maintains a structured wiki under `.free-llm-mcp/wiki/` containing markdown files with YAML frontmatter.

### Wiki Page Schema
```markdown
---
title: user_authentication_refactor
created: 2026-06-28T12:34:56.789Z
updated: 2026-06-28T12:34:56.789Z
confidence: 0.95
tier: semantic
tags: [code, adr, architecture]
links: [session_history_slug]
adr_ref: adr_001
---

# User Authentication Refactor

We decided to use Redis for session management instead of JWT tokens.
```

### Auto-ADR (Architecture Decision Record) Extraction
The wiki manager automatically parses all incoming agent completions for decision keywords. If a match is found, it creates/updates an ADR entry in the wiki:
- **Triggers**: `/decided to/i`, `/chose\s+.*\s+over\s+.*/i`, `/we\s+use\s+.*\s+because/i`, `/decision:/i`.

---

## 📄 PDF Index Offset Caching [NEW]

When a PDF file is referenced using a `#page=N` hash (e.g., `manual.pdf#page=12`), the server translates the page number using a cached offset.

### Cached Index Schema
Stored in long-term memory under `pdf:index:<pdf_filename_slug>`:
```json
{
  "offset": 4,
  "index_page": 1,
  "last_updated": "2026-06-28T12:34:56.789Z"
}
```
* **Offset**: The difference between the physical PDF page number and the printed document page number (e.g. if page 1 of the document is physical page 5, the offset is `4`).
* **Auto-Detection**: If no offset is cached, the server automatically runs a quick multimodal LLM check on physical page 1 to detect table-of-contents / index indicators and compute the offset.

---

## 🦾 Agentic Memory-State Patterns

### Session-Based Task Queues
Track multi-turn objectives without polluting the system prompt:
```json
{
  "key": "session/tasks",
  "value": {
    "nowQueue": ["Implement Granular Extractor (DONE)", "Uplift References (In-Progress)"],
    "improveQueue": ["Add performance metrics to logs", "Refactor regex to be more robust"]
  }
}
```

### Structured Skill Harvesting (`store_workspace_skill`)
Instead of raw strings, capture the full context of a completed feature or research block. This is the preferred way to persist high-fidelity knowledge.

```json
{
  "name": "auth-refactor",
  "description": "JWT to session migration findings",
  "what": ["Implemented Redis session store", "Disabled JWT middleware"],
  "why": "JWT was causing overhead in high-traffic scenarios.",
  "files": ["src/middleware/auth.ts"],
  "workspace_root": "/project/root"
}
```

---

## ⚠️ Constraints
- Memory is localized to `workspace_root`.
- `clear` is destructive and non-reversible — use only when explicitly requested.
- **Deduplication Required:** Avoid storing raw LLM outputs longer than 2000 tokens directly; summarize findings into structured skills via `store_workspace_skill` first.
