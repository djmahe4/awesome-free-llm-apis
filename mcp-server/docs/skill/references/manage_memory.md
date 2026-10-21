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

## Wiki (persistent workspace pages)

Markdown pages with frontmatter (`WikiMemory`, `src/memory/wiki.ts`), separate from the DAG/ADR/key-value stores.

**Actions:** `wiki_write`, `wiki_search`, `wiki_list`, `wiki_read`

```jsonc
{ "action": "wiki_write", "workspace_root": "...", "title": "Auth architecture", "content": "...", "tags": ["auth"], "links": ["Related Page"] }
// → { success: true, page }
{ "action": "wiki_search", "workspace_root": "...", "query": "jwt", "persona": "debugger" }
// → { results: WikiPage[] }
{ "action": "wiki_list", "workspace_root": "..." }
// → { pages: [...] }
{ "action": "wiki_read", "workspace_root": "...", "title": "Auth architecture" }
// → { page }
```

`pdf`- and `study`-tagged pages route to their own subdirectories automatically. `adr`-tagged pages route to an `adr/` subdirectory that `wiki_search`/`wiki_list` deliberately exclude — use `adr_write`/`adr_list` below for those instead of `wiki_write` with a manual `adr` tag.

---

## DAG memory (nodes + edges)

A per-workspace directed-acyclic node/edge graph (`DagMemory`, `src/memory/dag.ts`), separate from the wiki and key-value memory above. Reuses the same Ebbinghaus decay model as the rest of `MemoryManager` (`halfLifeDays`/`confidence`/`sourceCount`) — no separate decay formula.

**Actions:** `node_add`, `node_link`, `node_list`, `node_get`, `node_review`, `graph_query`

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

// reset a node's decay clock (lastReviewedAt) and bump confidence — call
// after actually re-confirming a node is still accurate
{ "action": "node_review", "workspace_root": "...", "nodeId": "<nodeId>" }
// → { success: true, node }
```

`node.type` is one of `text` | `image` | `video` | `audio` | `pdf_page`; a `node.filePath` pointer is rejected (throws) if it ends in `.pptx` or `.docx` — those media types are excluded from this store. `node_link` throws if the new edge would create a cycle — this is a DAG, not a general graph.

---

## Architecture Decision Records (ADRs)

Wiki pages tagged `adr`, stored in their own subdirectory excluded from general `wiki_search`/`wiki_list` results so ADRs don't dilute general codebase-wiki search.

**Actions:** `adr_write`, `adr_list`

```jsonc
{ "action": "adr_write", "workspace_root": "...", "title": "ADR-003: SEARCH/REPLACE over full-file regen", "content": "Context: ...\nDecision: ...\nStatus: accepted." }
// → { success: true, page }
{ "action": "adr_list", "workspace_root": "..." }
// → { adrs: [...] }
```

**Call `adr_list` before planning or acting on anything non-trivial** — a cheap check that prevents re-deciding or contradicting an already-recorded decision.

---

## Eisenhower matrix (priority backlog)

File-based per-workspace task store (`ProductivityMemory`, `src/memory/productivity.ts`) classifying tasks into `do` / `schedule` / `delegate` / `delete` quadrants (urgent×important).

**Actions:** `eisenhower_add`, `eisenhower_list`, `eisenhower_complete`

```jsonc
// explicit classification — the default path, no LLM call
{ "action": "eisenhower_add", "workspace_root": "...", "task": "Fix prod outage", "urgent": true, "important": true }
// → { success: true, task: { id, task, urgent, important, quadrant, tags, createdAt, completedAt, workspaceHash }, autoClassified: false }

// OR let an LLM infer urgent/important from the task text — OFF BY DEFAULT,
// must be explicitly opted into per call, never triggers implicitly
{ "action": "eisenhower_add", "workspace_root": "...", "task": "Fix prod outage", "autoClassify": true }

{ "action": "eisenhower_list", "workspace_root": "...", "quadrant": "do", "includeCompleted": false }
// → { tasks: [...] }
{ "action": "eisenhower_complete", "workspace_root": "...", "taskId": "<id>" }
// → { success: true, task }
```

`autoClassify` grounds its classification in a table of the workspace's other existing open tasks plus few-shot worked examples explaining the urgent/important distinction (time-pressure vs. goal-relevance) — see `classifyEisenhowerTask` in `src/tools/manage-memory.ts`.

**Call `eisenhower_list` before planning** to see the live backlog and avoid duplicating or contradicting open work.

---

## Pomodoro (focus-session tracking)

Session tracking in the same `ProductivityMemory` store as the Eisenhower matrix.

**Actions:** `pomodoro_start`, `pomodoro_stop`, `pomodoro_list`

```jsonc
{ "action": "pomodoro_start", "workspace_root": "...", "label": "Deep work", "durationMinutes": 25 }
// → { success: true, session: { id, label, durationMinutes, startedAt, stoppedAt, status, actualMinutes, workspaceHash } }
{ "action": "pomodoro_stop", "workspace_root": "...", "sessionRefId": "<id>", "aborted": false }
// → { success: true, session }
{ "action": "pomodoro_list", "workspace_root": "...", "pomodoroLimit": 20 }
// → { sessions: [...] }
```
