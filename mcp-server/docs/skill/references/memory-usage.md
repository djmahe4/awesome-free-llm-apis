# Memory Usage Strategy — `free-llm-apis`

The `manage_memory` tool provides content-addressed, workspace-aware persistence. 

**Architecture Note:** All memory is physically stored in the MCP server's local `data/memory.json` file. The `workspace_root` parameter is used to generate a unique cryptographic hash, acting as a logical namespace to isolate context between different projects.

---

## 🧠 Core Patterns

### 1. Workspace Fingerprinting
Always begin by listing the current workspace hash:

```json
{ "action": "list", "workspace_root": "/absolute/path/to/workspace" }
```

Use this hash to confirm context has not changed before re-loading prior state.

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
- **Ratio < 1.0:** Efficient. Normal operation.
- **Ratio > 1.5:** Data overhead. Flatten nested structures before next write.

---

## 🔁 Evolving Pipeline Memory Schema

Use structured keys to version agent knowledge across iterations:

```
research/<topic>/<iteration_number>   → findings string
subagent/<name>/instructions/<ts>     → instruction snapshot
learning/<task>/score_history         → JSON array of quality scores
```

### Example: Research Accumulation
Each research call appends to the topic's record:
1. `search` for `research/cybersecurity/3` (last known iteration).
2. Merge with new LLM output.
3. Store as `research/cybersecurity/4` for the next cycle.

### Example: Subagent Instruction Versioning
After each learning loop evaluation:
1. `search` for `subagent/recon-agent/instructions/latest`.
2. Generate improved instructions with a critique model.
3. Write back with a new timestamp key.
4. Old keys remain available for rollback.

---

## 🛠️ Agentic Memory-State Patterns [NEW]

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

### Self-Healing Instruction Pattern
If a subagent repeatedly fails, the master agent should re-write its `memory.json` instructions:
1. **Detect Failure:** Log Error `ERR-REF-01`.
2. **Search Memory:** Find `subagent/ref-extractor/v1`.
3. **Improvise:** Use `use_free_llm` to rewrite `v1.1` with a fix for `ERR-REF-01`.
4. **Update:** Store `subagent/ref-extractor/v1.1` and update the active pointer.

---

## ⚠️ Constraints
- Memory is localized to `workspace_root`.
- `clear` is destructive and non-reversible — use only when explicitly requested.
- **Deduplication Required:** Avoid storing raw LLM outputs longer than 2000 tokens directly; pipe through `code_mode` to summarize first.
