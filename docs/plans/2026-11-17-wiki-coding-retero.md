The repo’s memory layer is already the strongest part of the design—it just isn’t promoted consistently and is split across three overlapping graph stores. The plan below aggregates the earlier multi-language/YAML work with the new **cross-tool `manage_memory` promotion** and the **file-audit/comment-contract subtool**, while resolving the wiki/code-graph duplication you noticed.

---

## 🔍 Current-State Findings (what the code actually does)

### Prerequisites

1. `use_free_llm` is a tool that directly calls an LLM; it should be allowed an offline only option for local-model hypothesis loops. To be leveraged in the docs and skill-audit subtool, also cyber route should be able to call `use_free_llm` with a local provider consider locking upgrade requirement to protect multiple calls and models taking up vram.

### Tool registration & response shape

`mcp-server/src/tools/index.ts` is only a barrel export; it does not define tool descriptions or dispatch logic. The actual MCP tool list lives in `mcp-server/src/mcp/index.ts`:

- `use_free_llm`
- `vision_tool`
- `load_skill_prompt`
- `get_token_stats`
- `validate_provider`
- `manage_memory`

`manage_memory` is the only tool that advertises the full wiki/DAG/ADR/Eisenhower/Pomodoro surface. Its `action` union already includes `wiki_search`, `wiki_write`, `wiki_list`, `wiki_read`, `node_add`, `node_link`, `node_list`, `node_get`, `node_review`, `graph_query`, `adr_write`, `adr_list`, `eisenhower_add`, `eisenhower_list`, `eisenhower_complete`, `pomodoro_start`, `pomodoro_stop`, `pomodoro_list`. It also ends with an explicit **AGENT REMINDER** telling agents to call it before wide-context actions.

Dispatch is centralized in `server.ts`; the `manage_memory` case deliberately forwards **every field** rather than using a whitelist. Responses are JSON objects per action (e.g. `{ success: true, page }`, `{ nodes, edges }`), with `toMarkdownResponse` imported for markdown wrapping.

### Promotion is uneven

The root `harness-template.yaml` promotes `manage_memory` only in **top_level**, **architect**, and **reviewer** roles:

- `top_level` gets `search`, `wiki_search`, `wiki_read`, `adr_list`, `eisenhower_list`, `node_list`, `graph_query`
- `architect` gets `wiki_write`, `adr_write`, `node_add`, `node_link`
- `reviewer` gets `wiki_search`, `wiki_read` + writes

`coder` gets only `coding_agents` and `local_llm_patch`—no memory promotion at all. `use_free_llm`, `vision_tool`, `load_skill_prompt`, `get_token_stats`, and `validate_provider` have **no memory promotion** in their descriptions or dispatch paths.

### Wiki vs code-graph duplication is structural

There are three parallel graph representations:

| Store | What it holds | Backend |
|---|---|---|
| `DagMemory` (`memory/dag.ts`) | General blackboard nodes (`text`, `image`, `video`, `audio`, `pdf_page`) + edges | JSON files under `.free-llm-mcp/memory/dag/` |
| `RepositoryGraph` (`memory/dependency-scanner.ts`) | `code` / `doc` / `concept` / `external` / `pdf` nodes; `imports` / `references` / `links` / `invokes` edges | In-memory `Map` + `Edge[]` |
| `DiskSymbolDb` | `module` / `class` / `function` / `concept` / `sink` nodes; `imports` / `references` / `invokes` / `contains` / `implements` / `taints` edges | SQLite (`symbols.db`) |

The “wiki” is not a separate module—it is the **doc/concept side of `RepositoryGraph`** plus `WikiMemory` pages. Meanwhile the code graph is persisted in `DiskSymbolDb`. So the wiki and the code graph are two schemas over the same knowledge, fed by overlapping scanners (`WorkspaceDirScanner`, `DependencyScanner`, `WorkspaceWalker`, `embedded-snippet-scanner`). That is the duplication you are seeing.

---

## 🧠 Proposed Architecture: One Knowledge Builder, One Graph, Two Views

### 1. Collapse extraction into a single `WorkspaceKnowledgeBuilder`

Replace the three workspace walks with one pass that:

- Reuses the existing skip logic from `dir-scanner` and `indexer`.
- Routes each file by extension to a **YAML rule set** executed by `ast-grep`.
- For docs, uses a language-agnostic markdown/frontmatter parser.
- Emits a stream of `KnowledgeNode` objects tagged with `language`, `filePath`, `provenance`, and `kind` (`symbol`, `doc`, `concept`, `snippet`).
- Feeds **one graph store** (`DiskSymbolDb` as canonical).

### 2. Make `DiskSymbolDb` canonical; treat the wiki as a view

Keep SQLite as the persistent backend. Drop `RepositoryGraph` as a separate store—or keep it as a read-through cache over the same schema. Then:

- **Code graph** = `DagNodeRecord` filtered to `module` / `class` / `function`.
- **Wiki** = `DagNodeRecord` filtered to `concept` / `doc`, with edges of kind `references` / `links`.
- **Blackboard DAG** = the same store with `kind = 'blackboard'` or a dedicated partition for free-form nodes/edges.

This eliminates cross-store queries and gives the audit tool one place to compare against.

### 3. YAML + ast-grep as the multi-language layer

Create `mcp-server/rules/` grouped by concern:

```yaml
# rules/api-surface.yaml
- id: ts-function-declaration
  language: TypeScript
  rule:
    pattern: |
      function $NAME($$$ARGS) { $$$BODY }
  message: "TypeScript function declaration"

- id: py-function-def
  language: Python
  rule:
    pattern: |
      def $NAME($$$ARGS):
          $$$BODY
  message: "Python function definition"
```

Use `languageGlobs` for non-standard extensions (`.vue` → `html`, `.tsx` → `tsx`). The builder loads all rules, groups by language, and applies the matching subset. Adding Java/C/C++/Kotlin/Dart/Solidity becomes a YAML-only change—no TypeScript edits.

---

## 📣 Cross-Tool `manage_memory` Promotion via Keyword Matching

### Mechanism

Add a **central `MemoryHintMiddleware`** around the tool dispatch switch in `server.ts` (and mirror it in the MCP `CallTool` handler). Before returning any tool result, inspect the tool name and relevant string fields:

- `messages[].content`
- `query`
- `task`
- `title`
- `content`
- `keywords[]`
- `prompt`
- `description`

Match against a small keyword set:

```ts
const MEMORY_HINTS: Record<string, { action: string; reason: string }[]> = {
  plan:        [{ action: 'adr_list', reason: 'past architecture decisions' },
                { action: 'eisenhower_list', reason: 'open backlog' }],
  architecture:[{ action: 'adr_list', reason: 'prior ADRs' },
                { action: 'wiki_search', reason: 'architecture notes' }],
  decision:    [{ action: 'adr_list', reason: 'prior decisions' }],
  refactor:    [{ action: 'graph_query', reason: 'symbol/dependency graph' },
                { action: 'wiki_search', reason: 'codebase notes' }],
  task:        [{ action: 'eisenhower_list', reason: 'existing tasks' }],
  review:      [{ action: 'wiki_read', reason: 'prior review context' }],
  context:     [{ action: 'search', reason: 'prior session memory' }],
  documentation:[{ action: 'wiki_search', reason: 'existing docs' }],
  comment:     [{ action: 'wiki_read', reason: 'comment conventions' }],
};
```

If a match is found, append a structured `memoryHint` field to the tool response:

```json
{
  "memoryHint": {
    "suggestedTool": "manage_memory",
    "actions": ["adr_list", "eisenhower_list"],
    "reason": "The request mentions planning; checking ADRs and the backlog prevents duplicate/contradictory work."
  }
}
```

For `use_free_llm`, also prepend a system-style note to the model input: *“Before answering, consider whether `manage_memory` actions `adr_list` and `eisenhower_list` are relevant.”* This keeps the promotion cheap and deterministic.

### Tool-description updates

For every tool, add a `MEMORY PROMOTION` block to its description. Example for `use_free_llm`:

```
MEMORY PROMOTION:
- If the request involves planning, architecture, prior decisions, or an existing backlog,
  call manage_memory with action "adr_list" and/or "eisenhower_list" first.
- If the request involves code structure or refactoring, consider "graph_query" or "wiki_search".
```

Do the same for `vision_tool`, `load_skill_prompt`, `get_token_stats`, and `validate_provider`, though the last two rarely need it—keep the hint generic and short.

---

## 🧾 New `manage_memory` Subtool: `audit_file`

### Purpose

Index specific files, compare against the previously built graph, and raise **comment-contract and documentation drift**—excluding tests.

### Input schema

```ts
{
  action: 'audit_file',
  workspace_root: string,
  filePaths: string[],
  includeTests?: boolean,        // default false
  hypothesize?: boolean,        // default false
  compareGraph?: boolean,       // default true
  applyFeedback?: {
    corrections: Array<{
      nodeId?: string,
      filePath: string,
      line?: number,
      change: 'update_comment' | 'add_header' | 'add_function_doc' | 'update_wiki' | 'update_skill',
      content: string
    }>
  }
}
```

### Internal pipeline

1. **Parse** each file with the matching YAML/ast-grep rule set (or a lightweight fallback for unsupported languages).
2. **Extract**:
   - File header comment (license, purpose, author, SPDX).
   - Function/method headers: JSDoc for TS/JS, PEP 257 docstrings for Python, Javadoc for Java, etc.
   - Inline **written contracts**: comments containing `@contract`, `@pre`, `@post`, `@invariant`, `@throws`, `@returns`, `@sideeffect`, `@threadsafe`.
   - Symbol definitions and their graph IDs.
3. **Compare** against the existing graph (`DiskSymbolDb`):
   - Symbols present in code but missing from graph → `graphDrift.missingNodes`.
   - Graph symbols no longer in code → `graphDrift.staleNodes`.
   - Signature changes → `graphDrift.signatureChanges`.
   - Wiki/doc page references to renamed/removed symbols → `docDrift`.
4. **Comment audit**:
   - Missing file header.
   - Missing function/method header doc.
   - Missing written contract on exported/public functions.
   - Comment text that contradicts graph metadata (e.g. comment says `@returns User` but graph says return type `User | null`).
   - Stale comments referencing removed parameters.
5. **Test exclusion**: skip paths matching `**/__tests__/**`, `**/*.test.*`, `**/*.spec.*`, `**/test_*.py`, `**/*_test.go`, `**/tests/**`, etc., unless `includeTests: true`.

### Output shape

```json
{
  "success": true,
  "filesAudited": 3,
  "graphDrift": {
    "missingNodes": [{ "filePath": "src/auth.ts", "symbol": "refreshToken" }],
    "staleNodes": [],
    "signatureChanges": [{ "nodeId": "fn:login", "before": "(user, pass)", "after": "(user, pass, opts)" }]
  },
  "commentAudit": {
    "missingFileHeaders": ["src/auth.ts"],
    "missingFunctionHeaders": [{ "filePath": "src/auth.ts", "symbol": "refreshToken" }],
    "missingContracts": [{ "filePath": "src/auth.ts", "symbol": "refreshToken", "expected": ["@throws", "@returns"] }],
    "staleComments": [{ "filePath": "src/auth.ts", "line": 42, "comment": "@returns User", "graphType": "User | null" }]
  },
  "suggestedActions": [
    { "action": "wiki_write", "reason": "Document refreshToken contract" },
    { "action": "node_review", "reason": "Graph node fn:login signature changed" }
  ]
}
```

### Local-model hypothesis loop

If `hypothesize: true`:

1. Build a compact prompt containing:
   - The audited file(s).
   - The graph neighborhood of each symbol (`getNeighborhood`-style data).
   - Relevant wiki pages / ADRs from `manage_memory`.
   - The comment audit report.
2. Call `use_free_llm` with a **local provider** and a strict JSON response schema:

```json
{
  "hypothesis": "refreshToken rotates the refresh token and revokes the old one.",
  "confidence": 0.82,
  "uncertainties": [
    "Whether rotation is atomic under concurrent requests",
    "Whether revoked tokens are blacklisted or deleted"
  ],
  "suggestedCommentUpdates": [
    { "symbol": "refreshToken", "comment": "@throws {TokenReuseError} if the old token was already rotated" }
  ],
  "suggestedWikiUpdates": [
    { "page": "Auth Flows", "section": "Token Rotation", "content": "..." }
  ]
}
```

3. Return this alongside the audit report. The user can then call `audit_file` again with `applyFeedback.corrections` to:
   - Update graph nodes/edges (`node_review`, `node_link`).
   - Write/update wiki pages (`wiki_write`).
   - Create an ADR if the correction is architectural (`adr_write`).
   - Suggest skill-file updates if the skill references the changed symbol.

This turns the audit into a **human-in-the-loop graph/doc correction loop**, exactly as you described.

---

## 📚 Documentation, Skills, AGENTS.md, and Linting

### Markdown schema tree

Standardize wiki pages with frontmatter:

```yaml
---
type: concept | module | api | adr
scope: auth
language: typescript
symbols: [login, refreshToken]
files: [src/auth.ts]
contracts:
  - symbol: refreshToken
    pre: ["valid refresh token cookie"]
    post: ["old token revoked", "new token issued"]
lastReviewed: 2026-11-15
confidence: 0.8
---
```

The audit tool validates that every exported symbol has a corresponding `concept` or `api` node, and suggests `wiki_write` when missing.

### Skill-file management

If a skill file (`SKILL.md`, `AGENTS.md` skill blocks) references a symbol/file that the audit flags as drifted, append a `skillUpdateSuggestions` array:

```json
{
  "skillUpdateSuggestions": [
    {
      "skill": "auth-helper",
      "reason": "refreshToken signature changed",
      "suggestedEdit": "Update the example call to include the options parameter."
    }
  ]
}
```

### Existing documentation schema awareness based on tree and file name patterns

Our workspace doenst follow documentation or update regularly, so lets do a self reterospective audit of the documentation and skill files. The audit tool should check for:
- Contradirctory information between the documentation and the code graph.
- Missing documentation relating to the architecture and how it maps to the user (if user doc), if dev doc then (how the contracts and code graph relate to the architecture, kanban boards, mermaid relevant digram decision based on the pattern identification). All of these:

```
MERMAID_DIAGRAM_TYPES = {
    "Flowchart": {
        "keyword": "flowchart",
        "description": "Visualizes control flow, decision trees, algorithm logic, microservice routing, and CI/CD pipelines.",
    },
    "Sequence Diagram": {
        "keyword": "sequenceDiagram",
        "description": "Models REST/gRPC API lifecycles, OAuth/authentication handshakes, and asynchronous message passing.",
    },
    "Class Diagram": {
        "keyword": "classDiagram",
        "description": "Represents object-oriented domain models, interface contracts, inheritance hierarchies, and type relationships.",
    },
    "Entity Relationship (ERD)": {
        "keyword": "erDiagram",
        "description": "Defines relational database schemas, SQL tables, primary/foreign keys, and entity cardinality.",
    },
    "State Diagram": {
        "keyword": "stateDiagram-v2",
        "description": "Maps finite state machines (FSM), order/job lifecycles, WebSocket connection states, and UI transitions.",
    },
    "C4 Architecture": {
        "keyword": "C4Context",
        "description": "Illustrates multi-level system architecture across System Context, Containers, Components, and Deployment.",
    },
    "Architecture": {
        "keyword": "architecture-beta",
        "description": "Depicts cloud infrastructure topologies, VPC/subnet groupings, service icons, and directional network edges.",
    },
    "Git Graph": {
        "keyword": "gitGraph",
        "description": "Displays branching strategies, release tagging, merge commits, and cherry-pick workflows.",
    },
    "Gantt Chart": {
        "keyword": "gantt",
        "description": "Tracks sprint roadmaps, release milestones, task dependencies, and critical path scheduling.",
    },
    "User Journey": {
        "keyword": "journey",
        "description": "Maps end-to-end UX flows, onboarding friction points, and actor satisfaction scores across product steps.",
    },
    "Mindmap": {
        "keyword": "mindmap",
        "description": "Organizes system decomposition, feature brainstorming, threat modeling trees, and knowledge hierarchies.",
    },
    "Requirement Diagram": {
        "keyword": "requirementDiagram",
        "description": "Provides SysML-style traceability linking functional and security requirements to test cases and modules.",
    },
    "Packet Diagram": {
        "keyword": "packet-beta",
        "description": "Details bit-level network protocol headers such as TCP, IPv4/IPv6, and custom binary frames.",
    },
    "Block Diagram": {
        "keyword": "block-beta",
        "description": "Creates grid-aligned hardware and software block layouts requiring explicit column positioning.",
    },
    "XY Chart": {
        "keyword": "xychart-beta",
        "description": "Plots benchmarking metrics, latency distributions, and numerical bar or line series.",
    },
    "Quadrant Chart": {
        "keyword": "quadrantChart",
        "description": "Categorizes items across two axes for technical debt prioritization and risk matrices.",
    },
    "Timeline": {
        "keyword": "timeline",
        "description": "Chronicles chronological events, release histories, and incident postmortem sequences.",
    },
    "kanban": {
        "keyword": "kanban",
        "description": "Visualizes task boards, work-in-progress limits, and team workflow states.",
    },
}
```
Sub Tool implementation (Hypothesize and apply feedback via local model):

```
{
  "action": "audit_documentation",
  "workspace_root": string,
  "filePaths": string[],
  "includeTests": boolean,        // default false
  "hypothesize": boolean,        // default false
  "compareGraph": boolean,       // default true
  "applyFeedback": {
    corrections: Array<{
      filePath: string,
      line?: number,
      change: 'update_doc' | 'add_header' | 'add_diagram' | 'update_skill',
      content: string
    }>
  }
}
```

### AGENTS.md and linting promotion

The audit tool should append a **`Safe Practices`** section to the workspace `AGENTS.md` (or suggest an update) containing:

- **TypeScript/JavaScript**: ESLint + `@typescript-eslint`, Prettier, `eslint-plugin-jsdoc` for contract comments.
- **Python**: Ruff (`ruff check`, `ruff format`) + PEP 8 / PEP 257 docstring rules; optionally `pydocstyle`.
- **General**: no commented-out code, no stale TODOs without an owner, file headers required for new files, exported functions require a contract comment.

Because `AGENTS.md` initialization is already in the pipeline, this is an append/update operation, not a new bootstrap step.

---

## 🗺️ Phased Implementation Roadmap

| Phase | Work | Why first |
|---|---|---|
| **0 – Inventory & dedup map** | Document every scanner/store; mark `RepositoryGraph` vs `DiskSymbolDb` vs `DagMemory` overlaps. | Prevents building on the split-brain. |
| **1 – Cross-tool memory promotion** | Add `MemoryHintMiddleware` in `server.ts` dispatch; update all tool descriptions with `MEMORY PROMOTION`. | Cheap, immediate behavior change; no schema work. |
| **2 – YAML/ast-grep extraction** | Create `rules/`; replace hardcoded regex in `cross-file.ts`, `call-sites.ts`, `symbol-graph-cache.ts` with rule loading. | Unlocks multi-language support. |
| **3 – Graph unification** | Make `DiskSymbolDb` canonical; turn wiki into a filtered view; keep `RepositoryGraph` as cache only. | Removes duplication and gives the audit tool one source of truth. |
| **4 – `audit_file` subtool** | Implement comment-contract extraction, graph comparison, test exclusion, structured report. | Core new capability. |
| **5 – Local-model hypothesis loop** | Add `hypothesize: true` path, `applyFeedback` corrections, graph/wiki/ADR updates. | Human-in-the-loop correction. |
| **6 – Docs/skills/AGENTS.md/linting** | Schema validation, skill drift suggestions, safe-practice promotion. | Ties audit to documentation and tooling. |
| **7 – TDD integration** | Point existing TDD harness at AST-extracted surfaces; add snapshot tests for YAML rules. | Preserves the “decent TDD” already in place. |
| **8 - Coding agents task decomposition** | Auto task decomposition action to `manage_memory`; use graph + wiki to identify breaking changes(heavy nodes) and suggest subtasks split verified by the agent which calls. | Makes coding agents more autonomous and less hallucination-prone. |

---

## ⚠️ Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **ast-grep rule cannot span multiple languages at once** | Separate rules per language in the same YAML file; loader routes by extension. |
| **Parsing every file with ast-grep is slow** | Reuse `SymbolGraphCache` content hashes—only parse changed files. |
| **Comment-contract detection false positives** | Start with a small, explicit keyword set (`@contract`, `@pre`, `@post`, etc.); make severity configurable. |
| **Local model hallucinates hypotheses** | Always return `confidence` + `uncertainties`; require `applyFeedback` for writes—never auto-apply. |
| **Graph migration breaks existing data** | Add a compatibility view over `DiskSymbolDb`; migrate JSON `DagMemory` nodes into the same store with a `kind` discriminator. |
| **Test exclusion misses unusual naming** | Make test patterns configurable in `rules/tests.yaml`; default to the common set but allow overrides. |

---

## 💎 Bottom Line

The harness already proves `manage_memory` is the right abstraction—it just promotes it in only three roles. A **central keyword matcher** plus **tool-description hints** extends that promotion to every MCP tool without LLM cost. The **`audit_file` subtool** turns the graph from a passive cache into an active contract checker: it compares code to graph, comments to signatures, and docs to symbols, then uses a local model to hypothesize understanding and a user-feedback loop to correct both graph and documentation. Unifying the three graph stores around `DiskSymbolDb` and moving extraction to YAML/ast-grep removes the wiki/code duplication while making multi-language support a configuration exercise.
