# Agentic Architecture & Steering Mechanics

This document provides a deep dive into the internal mechanics of the `@mcp:free-llm-apis` server, specifically the grounding protocols and the steering engine.

---

## 🛡️ Internal Grounding & Attestation Protocol

The pipeline enforces strict grounding to prevent hallucinations when performing project-scoped tasks.

### 🔄 Pre-emptive Memory Indexing
Triggered automatically for `agentic: true` requests in a valid workspace. The `WorkspaceContextMiddleware` runs a non-force indexing pass to ensure the LLM's vector search is grounded in the absolute latest state of the project files.

### 🏷️ Attestation Tags
The pipeline injects a **Grounding Protocol** into the system prompt of every LLM it calls. This forces the model to tag its claims:
- **`[RETRIEVED]`** — fact is directly present in injected context blocks (e.g., resolved `file://` or `artifact://` URIs, session memory).
- **`[NOT FOUND]`** — the file or context is mentioned but its content was not found or resolved. The model MUST stop and ask the user to provide it.

### 🚪 Read-First Gate
Triggered automatically when `workspace_root` contains a `README.md`. The pipeline injects a mandatory instruction forcing the model to verify all assertions against the provided context blocks **before** proposing any architecture or implementation.

---

## 🤖 Agentic Middleware v2 (Steering Engine)

The server features a **Context-Aware Steering Engine** (v1.0.5 Hardened) that manages stateful task execution via the `use_free_llm` tool. It transforms static documentation into a dynamic, token-efficient prompt pipeline.

### 🧠 Intelligent Behaviors
- **Stabilized Orchestration**: Circular dependencies eliminated, ensuring consistent middleware initialization across concurrent sessions.
- **Semantic Prompt Resolution**: Automatically indexes relevant prompt sections. A stricter selection threshold (score >= 3) ensures instructions are mission-critical.
- **Stateful Project Memory**: Persists architectural decisions and harvested skills in `.free-llm-mcp/skills/`.
- **Automatic Task Decomposition**: Automatically splits complex goals into discrete, trackable steps (capped at 4 for stability).

### 🧐 Observability
The middleware implements **Research Validation Logging**:
- **[RESEARCH-VALIDATION]** logs fire during pre-execution (detection) and post-execution (grounding check).
- Provides an explicit audit trail for external knowledge lookups and architectural steering.

---

## 🦾 Advanced Agentic Patterns

### Pattern 1: Subagent Bootstrap with Memory
1. `manage_memory search` → found prior plan?
   - Yes: use as context for current task
   - No: generate plan via `use_free_llm`, save output to file
2. `list` → verify workspace hash matches expected state
3. Execute subagent with plan as system context

### Pattern 2: Terminal Task Completion (The Handshake)
1. `finalize_task` → Generate final summary/artifact
2. `store_workspace_skill` → Save structured summary + decisions as a skill
3. `index_workspace` → Ground the new state in semantic memory
4. [DONE] → Inform user and exit
