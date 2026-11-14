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

An approval authorises ONE execution of the exact call (run + callId + argsHash). A rerun, or a second identical call, needs a new approval. `approvals` still lists entries when the run's declaration can no longer be loaded (it adds a `warning`). `resume` on a run still waiting on a monitored process returns a `note` saying nothing advanced. `deploy` validates `goal` (non-empty text, up to 20000 characters), `maxTokens` (positive number) and `harness` (text) before creating anything. Set `HARNESS_RESTRICT_ROOTS=1` to limit runs whose declaration has no `allowedWorkspaceRoots` to the server working directory plus `WORKSPACE_ROOTS`.
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

### 5. `resume`
Continues a paused/aborted run from the persisted cursor:
```json
{ "action": "resume", "runId": "0e59c252-4467-422f-ae52-7b1f3c306631" }
```
- The plan on resume is read back from `tasks.md` — it is not rebuilt — so lane cycle ids (`phase#cN`) persist across restarts and resume continues at exactly the untouched `pending` step.
- Fail-closed cycle guard: a `#cN` step is re-validated against the declaration's `lane`/`maxCycles` before it runs (a hand-edited `tasks.md`, or a declaration whose `maxCycles` shrank between deploy and resume, cannot sneak in an extra cycle).

---

## 📜 Declaration Discovery (`appsec.yaml`)

Declarations can live with the project instead of the server. A bare name like `harness: appsec` resolves in order:

1. **Uniform workspace dir** — `<workspaceRoot>/.free-llm-mcp/harness/<name>.yaml` (canonical, wins)
2. **Legacy dir** — `<workspaceRoot>/harness/<name>.yaml`
3. **Built-in** — mcp-server's bundled `harness/` directory

…or an explicit path-like name (`./policy.yaml`, absolute path) is loaded directly. Example external declaration (owned by the audited project, versioned with it):

```yaml
harness:
  name: appsec-harness
  schemaVersion: 1
  lane: [recon, security_analyst, fixer]   # ordered phases — see below
  maxCycles: 3
  budget: { maxTokens: 100000, maxToolCalls: 80, maxWallMinutes: 45, supervisorShareMax: 0.2 }
  # Relative roots resolve against THIS file's directory — '../..' = project root,
  # so runs stay scoped to the audited project regardless of server cwd.
  allowedWorkspaceRoots: ['../..']

handoff:
  schemaVersion: 1
  lowConfidenceThreshold: 0.7
  maxDepth: 3

roles:
  top_level:
    tools: [{ tool: manage_memory, actions: [search, wiki_search, wiki_read] }]
  fixer:
    requiresApproval: true                 # HITL: remediation patches need approval
    tools: [{ tool: coding_agents }]

writes:
  - { tool: manage_memory, actions: [wiki_write, adr_write, node_add, node_link] }

cyberTools: [katana]                       # bridge allowlist — see cyber_tool.md
```

`allowedWorkspaceRoots` is enforced by `assertWorkspaceRootAllowed` at deploy **and** at every resume — a run cannot migrate to another workspace root mid-flight.

---

## 🔁 Lane Phases & Cycles

- `harness.lane` is an ordered list of phase names (= role names). Validated at load: non-empty, unique, each an executable non-`top_level` role. `maxCycles` is only valid alongside `lane` (integer ≥ 1, default 1).
- With a lane, the plan is exactly the lane walked `maxCycles` times: cycle 1 uses plain phase ids (`recon`), cycles ≥ 2 tag the task id `phase#cN` (`recon#c2`), and each `#cN` id is a separate `tasks.md` entry with its own attempts and handoffs.
- Without a lane the legacy linear plan (role order, no cycle semantics) still applies — existing declarations are unaffected.
- Each executed lane step emits a **`phase` trace event before it runs**: `{ phase, cycle, taskId, index, total }` (`role`/`phase` stay the base name; `taskId` carries the full `#cN` id). Inspect with `action: 'trace'` — this is the per-cycle progress view.

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

### 3. Hard-Deny Write Guard
LLM-authored patches (`patches[].filePath` from `coding_agents` / `local_llm_patch`) are validated **before** the CAS snapshot is taken — a rejected path is never applied:

- **Protected paths**: the whole uniform declaration dir `.free-llm-mcp/harness/**`, legacy `harness/*.yaml|*.yml`, and the bridge capability file `.free-llm-mcp/bridges.json`.
- Rejection is a hard-deny with a `[security] hard-deny: patch targets protected harness path '…'` error — agent patches can never rewrite harness policy or bridge config (policy/bridges change only via human edits to the project files).
- Internal server operations (CAS restore/undo, resolve actions) are exempt — the guard validates only patch paths coming from the LLM.

### 4. Cyber Bridge Allowlist (`cyberTools`)
The declaration-level `cyberTools: [name, …]` list is the fail-closed gate for `cyber_tool` `run_action` bridge dispatch (see `cyber_tool.md`):

- A bridge not named in `cyberTools` → `needs_approval` (absent list = no bridge dispatches through the harness at all).
- The role must *also* allowlist `cyber_tool`/`run_action` through its normal `tools` rules — both gates must pass.

## Collapsible Context Injection Hooks (`ContextInjectionHook`)
Roles can receive pre-folded "thought bundles" instead of raw context blobs. Bundles are created from `tasks.md` blackboard entries and injected as structured data through the tool gateway (`src/harness/context-injection-hook.ts`).

### ThoughtBundle
| Field | Type | Description |
|---|---|---|
| `id` | string | Unique bundle id |
| `text` | string | The thought / context text |
| `source` | `'rea' \| 'reasoning' \| 'external'` | Origin of the bundle |
| `timestamp` | number | Creation epoch ms |
| `tool`, `action`, `goal` | string (optional) | Tool/action/goal association |

### InjectionContext
```json
{ "folded": true, "summary": "…", "thoughts": [ThoughtBundle, …] }
```
When `folded: true`, the full bundle list is withheld from the role frame; only `summary` (if present) is injected.

### Hook options
- `foldByDefault?: boolean` — collapse bundles by default (default `true`).
- `triggers?: string[]` — role keywords that activate bundle injection.
- `tasksPrefill?: boolean` — pre-load bundles from the run's `tasks.md` before the role starts.

### fromTasksFile
`fromTasksFile(tasksMdPath, options)` synchronously reads a `tasks.md` file and builds `ThoughtBundle[]` from its task entries. Missing or unreadable paths are tolerated (empty bundle list, never throws).

### Wiring
Bundles flow through `ToolGateway.invoke` — no new endpoint; the existing `/api/harness/runs/:runId` trace carries the folded marker.

## Laya Deviation Validation (`laya-bridge.ts`)
Each proposed step may be validated against a laya-style reasoning mirror before execution.

### checkThoughtDeviation
- Inputs: the role's last-3 trace rows (thought bundles) → POST `/v1/systemone`.
- Timeout: hard `AbortSignal.timeout(5000)` (5 s).
- Request criteria: alignment scoring plus `unsafe: { type: 'noul' }` (noull self-reference guard).
- When the laya service is unreachable, the sentinel response `NOT_AVAILABLE` is returned — never a fabricated score.

### enforceDeviationPolicy
| Result | Policy | Harness behavior |
|---|---|---|
| `NOT_AVAILABLE` | proceed | Lay service down — continue without validation |
| `drift > 0.5` | halt | Run halts with `Deviation guard: proposed step '<callId>' drifted from the goal (laya drift > 0.5)` |
| `unsafe > 0.4` | require_review | Human approval gate |
| tangential alignment | replan | Step is rescheduled through planning |
| otherwise | proceed | Normal execution |

Every evaluation emits a structured trace event:
```json
{ "type": "deviation", "data": { "callId": "…", "policy": "…", "alignment": 0.0, "drift_prob": 0.0, "unsafe_prob": 0.0, "latency_ms": 0 } }
```
Bridge failures are swallowed (they never break a run). In the dashboard, `deviation` events render as **Thoughts (N)** panels folded under their matching `tool_call` row.

## Thought Dataset Pipeline (`thought-dataset-writer.ts`)
Every validated thought is appended to a JSONL dataset for offline MoE expert training.

- **Location**: `process.env.THOUGHT_DATASET_DIR ?? <home>/.free-llm-mcp/thought-dataset/thoughts.jsonl`.
- **Row schema**:
```json
{ "thought_id": "<runId>:<callId>", "thought": "…", "tool": "…", "action": "…", "goal": "…", "alignment": 0.0, "drift_prob": 0.0, "expert_label": "…" }
```
- **Expert mapping**: `TOOL_TO_EXPERT` routes each tool/action pair to an expert shard id.
- **Rotation**: when the file exceeds 10 MB it is rotated to `thoughts.jsonl.<epoch-ms>.bak` and a fresh file starts.
- **Post-processor**: `scripts/thought_to_moe_dataset.py` splits the JSONL into `expert_<label>.jsonl` shards; embeddings use `all-MiniLM-L6-v2`, falling back to a deterministic md5-derived 16-dim mock vector when the model is unavailable.

## Quantum Oracle (`quantumOracleScore`)
Optional laya-bridge enhancement for multi-thought decisions:

- Circuit: `entangled_verification` preset on the quantum tool, `numBranches = min(thoughts.length, 8)`.
- Query: the first 3 thought texts joined as the reasoning question.
- Score: mean branch confidence across the verification circuit.
- Null-safe: on any bridge/model failure the score is `null` and the run proceeds — the oracle is opt-in (default off) and advisory only.
