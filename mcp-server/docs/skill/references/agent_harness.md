# `agent_harness`

**Purpose:** Multi-agent declarative harness runner. Orchestrates autonomous agents over structured declarations with explicit file ownership locks (`FileScopeRegistry`), inter-agent reasoning keyword collision & context relay (`ReasoningScopeRegistry` with `ShortTermMemory`), human-in-the-loop approvals, step traces, and selective role re-orchestration.

---

## 🛠️ Input Schema

```typescript
interface AgentHarnessInput {
  action: 'deploy' | 'resume' | 'rerun' | 'reorchestrate' | 'status' | 'approvals' | 'approve' | 'reject' | 'trace' | 'tasks' | 'abort';
  runId?: string;              // Required for all actions except deploy (generated if omitted)
  harness?: string;            // Declaration name, e.g. 'research-analysis' (default)
  goal?: string;               // Required for deploy
  workspace_root?: string;     // Target workspace root path
  maxTokens?: number;          // Token ceiling for agent execution
  approvalId?: string;         // Required for approve / reject
  note?: string;               // User feedback note on approve / reject
  limit?: number;              // Event limit for trace (default 200)
  role?: string;               // Required for rerun / reorchestrate
  followupContext?: string;    // Feedback/steer context injected on rerun
}
```

---

## ⚙️ Core Actions & Lifecycle

### 1. `deploy`
Deploys a new harness run against a declarative YAML/JSON configuration.
```json
{
  "action": "deploy",
  "goal": "Audit authentication flow and harden session tokens",
  "harness": "security-audit",
  "workspace_root": "c:/Users/mahes/project"
}
```
Creates `.free-llm-mcp/harness/<runId>/run.json`, initializes `tasks.md`, and launches the configured agent steps.

### 2. `rerun` / `reorchestrate`
Selectively re-runs a specific agent role from a completed or paused run without discarding prior step outputs.
```json
{
  "action": "rerun",
  "runId": "0e59c252-4467-422f-ae52-7b1f3c306631",
  "role": "security-reviewer",
  "followupContext": "Focus strictly on JWT cookie domain scoping and SameSite flags",
  "workspace_root": "c:/Users/mahes/project"
}
```
- Preserves all preceding steps and completed tasks.
- Updates the specified role's step results in `run.json` and updates `tasks.md`.
- Injects `followupContext` directly into the agent's prompt frame.

### 3. `status` & `approvals`
Audit active status, current step, and human-in-the-loop approval gates.
```json
{
  "action": "status",
  "runId": "0e59c252-4467-422f-ae52-7b1f3c306631"
}
```
```json
{
  "action": "approve",
  "runId": "0e59c252-4467-422f-ae52-7b1f3c306631",
  "approvalId": "appr-882",
  "note": "Approved with cookie flags"
}
```

### 4. `trace` & `tasks`
Inspect the sequential event log or parse the live `tasks.md` execution list:
```json
{ "action": "trace", "runId": "...", "limit": 50 }
{ "action": "tasks", "runId": "..." }
```

---

## 🔒 Concurrency & Scope Controls

### 1. File Scope Claims (`FileScopeRegistry`)
Prevents multi-agent write collisions across files in `.free-llm-mcp/harness/scopes.json`:
- Before modifying or claiming files, agents request file lease locks.
- Conflicting requests are rejected with `acquired: false` and the list of active conflict paths.
- On role completion or run abort, acquired file leases are automatically released.

### 2. Reasoning Collision & Weighted Context Relay (`ReasoningScopeRegistry`)
Coordinates findings across roles working concurrently or sequentially in `.free-llm-mcp/harness/reasoning_scopes.json`:
- **Collision Detection**: Roles register their scope with specific `keywords[]` and `findingsText`.
- **Short-Term Memory Sync**: Entries sync to `ShortTermMemory` under key `reasoning:<runId>:<agentId>:<role>` with Ebbinghaus memory decay.
- **Weighted Context Passing**: When a peer role runs with overlapping keywords, `checkAndRelayReasoningContext` extracts the highest-weighted keyword-bearing lines within a configured token budget (default 500 tokens).
- Relayed context is automatically prepended to the receiving role's reasoning frame.
