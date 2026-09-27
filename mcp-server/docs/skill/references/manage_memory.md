# `manage_memory`

**Purpose:** Manage persistent workspace-aware memory for context across sessions.

**Required params:** `action`
**Key optional params:** `workspace_root`, `query`, `limit`

### Invocation (search)
```json
{
  "action": "search",
  "workspace_root": "/abs/path/to/project",
  "query": "authentication"
}
```

See [Memory Usage Guide](memory-usage.md) for the underlying wiki structure, PDF offset caching, and vector store details.

---

## DAG memory (nodes + edges)

A per-workspace directed-acyclic node/edge graph (`DagMemory`, `src/memory/dag.ts`), separate from the wiki and key-value memory above. Reuses the same Ebbinghaus decay model as the rest of `MemoryManager` (`halfLifeDays`/`confidence`/`sourceCount`) — no separate decay formula.

**Actions:** `node_add`, `node_link`, `node_list`, `node_get`, `graph_query`

```jsonc
// create a node
{
  "action": "node_add",
  "workspace_root": "/abs/path/to/project",
  "node": { "type": "text", "content": "auth uses JWT refresh tokens", "tags": ["auth"] }
}
// → { success: true, node: { id, type, content, tags, createdAt, lastReviewedAt, halfLifeDays, confidence, sourceCount, workspaceHash } }

// link two nodes (rejects cycles)
{ "action": "node_link", "workspace_root": "...", "from": "<nodeId1>", "to": "<nodeId2>", "relation": "relates-to" }

// list / get / query the whole graph
{ "action": "node_list", "workspace_root": "...", "tags": ["auth"] }
{ "action": "node_get", "workspace_root": "...", "nodeId": "<nodeId>" }
{ "action": "graph_query", "workspace_root": "..." }
// → { nodes: DagNode[], edges: DagEdge[] }
```

`node.type` is one of `text` | `image` | `video` | `audio` | `pdf_page`; a `node.filePath` pointer is rejected (throws) if it ends in `.pptx` or `.docx` — those media types are excluded from this store. `node_link` throws if the new edge would create a cycle — this is a DAG, not a general graph.
