# Harness TDD + Per-File Rollback Plan

Repo: `/home/kali/Desktop/awesome-free-llm-apis` (branch `feat/harness-wiki-visualizer-movie-pipeline`).
Verify every batch: `npx tsc --noEmit -p tsconfig.json` && `npm test` && `git status`.

## Status

| Track | State |
|---|---|
| A1/A2 harness workspace-root discovery & approvals | ✅ done |
| T0 characterization tests | ✅ done (18 tests green) |
| T1 uniform-dir discovery (`.free-llm-mcp/harness/` first, legacy, builtin) | ✅ done |
| Env: `OLLAMA_LOCAL_BASE_URL` / `SEARXNG_BASE_URL` + `.env.example` | ✅ done, verified live (`modelUsed: qwen2.5-coder:7b`, SearXNG 200, apply+rollback E2E passed) |
| R-series: per-file rollback, persistence, stable session | 📋 this plan |
| T4/T5 lane declaration + cyclic plan, `phase#cN` cycles, phase traces, resume cursor | ✅ done |
| T6 session-memory (implicit harness memory) | ✅ **implemented 2026-10-02** — strict TDD, `tests/harness-session-memory.test.ts` 9/9, suite 159/966, tsc 23, precommit 0 |
| T7 hard-deny write guard | ✅ done (`tests/harness-write-guard.test.ts` 11/11) |
| T8 cyber_tool `run_action` project bridge + `cyberTools` | ✅ done (`tests/cyber-tool-bridge.test.ts` 14/14) |
| T9 browser_tool harness integration | 📝 spec recorded (see below) — user-agreed hypothesis |
| T10 config-path | ⏭️ skipped per user (2026-10-02) |
| T11 docs (T5/T7/T8 coverage) | ✅ done — `docs/skill/references/agent_harness.md` + `cyber_tool.md` updated |
| T12 cyber scope enforcement (HITL/audit) | 📝 spec recorded (see below) — user-agreed hypothesis, overlaps T8 |

## Approved design decisions (R-series)

User Q&A: session = **stable workspace session**; CAS **persists to disk**; depth **3**; TTL **24h cleared on startup**.

Facts driving the design:
- CAS (`src/memory/ContentAddressableCheckpoint.ts`) is 100% in-memory today → history dies every restart.
- Session fallback `omp-${Date.now()}` (`coding-agents.ts:1757`) fragments history per call.
- Apply loop already builds `preApplyMap` (pre-apply file contents) at `coding-agents.ts:2363+` — the exact data per-file history needs.
- Boot hook precedent: `reconcileRunsOnBoot()` at `src/server.ts:1643`.
- CAS blobs dedup by SHA-256 → depth-3 history costs ≤3 versions of *patched files only*.

### R1 — Per-file ring buffer (depth 3)
- `ContentAddressableStore`: add `fileHistory: Map<key, string[]>`, key = `${resolvedWorkspaceRoot}\u0000${relPath}`, **newest-first** ring, cap `CAS_FILE_HISTORY_DEPTH` (default 3). Array slot `null` = file did not exist (undo of a new file = delete it).
- Hook: in apply loop after `preApplyMap` is built and before transactional write → `recordFileVersions(workspaceRoot, preApplyMap)` (stores the *replaced* version).
- New resolve actions (LLM patches go through existing guard; these are internal ops, **exempt from T7 write-guard**):
  - `resolve: {action:'undo_file', filePath}` → pop newest version, atomic restore (path-traversal guard like `restoreCheckpointToDisk`), returns `{restored, remainingDepth}`; error `No more history` when empty.
  - `resolve: {action:'file_history', filePath}` → read-only list of versions + depth.
- Semantics: after v1→v2→v3→v4, history=[v3,v2,v1] → 3 undos restore v3, v2, v1; 4th errors. Only the target file is touched.

### R2 — Disk persistence + 24h prune on boot
- Dir: `<baseDir>/.free-llm-mcp/cas/` (`blobs/<sha256>` + `index.json` with manifests, fileHistory (+`updatedAt`), atomic tmp+rename).
- Write path: keep in-memory as source of truth (sync APIs stay sync); **flush** after each apply (async context) via `flushCasToDisk()`; **hydrate** on boot `loadCasFromDisk()`.
- `pruneCasOnBoot(baseDir)`: drop manifests/fileHistory entries older than `CAS_TTL_MS` (default 24h), GC blob files unreferenced by anything surviving, write index. Called next to `reconcileRunsOnBoot` (`src/server.ts:1643`).
- Tests must stay isolated: no disk I/O unless `initCasPersistence(dir)` called (server does it; vitest keeps pure in-memory behavior).

### R3 — Stable workspace session
- `coding-agents.ts:1757`: `input.sessionId || 'omp-${Date.now()}'` → `input.sessionId || 'omp-ws-' + sha1(path.resolve(input.workspaceRoot || process.cwd())).slice(0,12)`.
- Effect: repeated applies/status polls on one workspace share one session; different workspaces differ; history keyed by workspace anyway (double protection). Behavior change (document): sessions are no longer unique-per-call when sessionId omitted.

### R4 — HTTP endpoint gap (approved one-liner)
- `src/server.ts` `POST /api/coding_agents`: destructure `resolve: req.body.resolve` so apply/undo/rollback work over HTTP (currently `/api/tool` only).

## Execution order

1. **R4** one-liner (same edit as R3's endpoint touch — batch together).
2. **T1 red→green** (in flight, designed): append describe to `tests/harness-declaration-external.test.ts` — uniform beats legacy, uniform beats builtin (`research-analysis`), legacy fallback, 3-candidate error; update A2 doc assertions to new wording. Green: `resolveDeclarationPath` candidates = [ws/.free-llm-mcp/harness, ws/harness, builtin], doc/comment updates in `declaration.ts`, `mcp/index.ts`, `agent-harness.ts:25`.
3. **R3** red test (stable sessionId) → green.
4. **R1** TDD: `tests/cas-file-history.test.ts` — depth cap (4 applies, 3 undos, 4th errors), single-file isolation, undo-new-file-deletes, existing `tests/cas-checkpoint.test.ts` green.
5. **R2** TDD: `tests/cas-persistence.test.ts` — flush→hydrate round-trip, backdated entries + orphan blobs pruned on boot, fresh kept, no disk without init.
6. **Resume T6–T12** (T0–T5 done incl. lane phase traces; **T8 done** — cyber_tool `run_action` project-bridge mechanism + schema + `cyberTools` declaration, `tests/cyber-tool-bridge.test.ts` 14/14; **T7 done** — hard-deny write guard `src/harness/write-guard.ts` (`isProtectedWritePath`/`assertPatchPathAllowed`) wired at top of coding-agents 4c before CAS snapshot, protects `.free-llm-mcp/harness/**`, legacy `harness/*.{yaml,yml}`, `.free-llm-mcp/bridges.json`, `tests/harness-write-guard.test.ts` 11/11; precommit gate fixed — server.ts agentic plan now gated on `resolvedWsRoot !== undefined` (no server-cwd fallback, regression test in `tests/steering-eval.test.ts`, 8/8) + `OLLAMA_LOCAL_BASE_URL` row in dashboard Quickstart, `npm run verify:precommit` passes, tsc baseline now **23**, suite 159/966; next: T11 docs (done — see table), T10 skipped per user, **T6 done** (session-memory, see spec below), T9/T12 specs recorded below).

## Recorded specs (T6 / T9 / T12)

### T6 — session-memory (implicit harness memory, NOT an MCP tool)
- The harness owns `session-memory.jsonl`.
- Before each LLM turn, it injects the last 3–5 entries into the system prompt.
- After the LLM turn, it parses the output and appends the new finding/hypothesis to the JSONL.
- Exposed **only** in the dashboard debug tab (Agent Harness tab) as a live viewer.
- Do **not** wire it as a tool for the LLM.
- Status: spec recorded — ready to implement (code not yet written).

#### ChatLogger retro (2026-10-02) — non-duplication contract
Existing mechanism reviewed: `src/utils/ChatLogger.ts` (`logChatTurn`/`logToolCall`) writes
`~/.free-llm-mcp/projects/<sessionId>/chat-logs.json` (JSON array, `{sessionId, timestamp, type:
'chat'|'tool'|'error', payload}`, 200-entry cap, 5MB rotation → `chat-logs.1.json`, auto `name.txt`
title, HTTP path uses `withFileLock`). Wired into: MCP tool entry (mcp/index.ts:1025 — logs every
tool incl. `agent_harness`), HTTP `/api/tools/*` (server.ts:595, self-logging set excludes
use_free_llm/coding_agents/cyber_tool/browser_tool/…), AgenticMiddleware user/assistant turns
(**agentic mode only** — harness passes `agentic:false` so its turns never reach it), use-free-llm
inner tool-call interception (:752), POST `/api/chat-log/:sessionId`. Reader: dashboard
**Conversations tab** (`/api/sessions` + normalized read at server.ts:1036/1100).

Findings: harness `use_free_llm` turns (`registryKey = 'harness:<runId>'`, `agentic:false`,
`isOnePass:true`) are **not currently logged** as chat turns — only summary `agent_harness`
tool_call entries (via MCP/HTTP wrapper) and inner LLM tool-calls land in `projects/harness:<runId>/`.
Lessons (`manage_memory` node graph, recallLessons/writeLessonNode) are a third, separate
mechanism (per-role retry-strategy memory) — do not fold into session-memory either.

**T6 must NOT duplicate ChatLogger. Contract:**
1. ChatLogger remains the only full-fidelity transcript mechanism (titles/rotation/locks).
   T6 does not import `logChatTurn`/`logToolCall`, never writes transcripts, titles, latencies,
   tool calls or errors into session-memory.
2. `session-memory.jsonl` = distillate only: `{ts, runId, role, type:'finding'|'hypothesis',
   text}` (text truncated), appended once per completed LLM turn whose output parses to a
   finding/hypothesis. It is prompt-memory, not an audit log.
3. Dashboard: new harness-tab "Session Memory" section fed by
   `GET /api/harness/runs/:runId/session-memory` — the Conversations tab stays the sole
   transcript viewer (no second history UI).
4. Enforced by a test: `src/harness/session-memory.ts` source must not reference ChatLogger,
   and its entry schema must differ from chat-log entries.

**Status: implemented 2026-10-02 (strict TDD — red 7/9 → green 9/9).**
- `src/harness/session-memory.ts` — `readSessionMemory`/`recentSessionMemory` (last 5)/
  `appendSessionMemory` (withFileLock)/`buildSessionMemoryPromptBlock`/`parseTurnMemory`
  (hypothesis regex, 2000-char cap); `HarnessStore.runDirPath` getter.
- Runner: `resolveStepDispatch(..., memoryBlock)` — block appended to system prompt only
  when non-empty (byte-identical payload when no entries); read once per step, reused on
  retry; append gated on `run.status==='complete'` + `toolName==='use_free_llm'`
  (strict LLM turns only), `.catch(() => {})` non-fatal.
- **Deviation from contract point 3:** entries are returned as `sessionMemory` inside the
  existing `GET /api/harness/runs/:runId` detail response instead of a separate
  `/session-memory` endpoint (single fetch feeds the viewer). Dashboard section id:
  `#harness-session-memory-view` (index.html after trace view, app.js `inspectHarnessRun`).
- Not an MCP tool — no action in `agent-harness.ts`, no `mcp/index.ts` registration
  (source-check tests enforce).

### T9 — Browser Tool Integration (hypothesis, user-agreed)
- Wire `browser_tool` into the harness loop so the agent can navigate and extract DOM/network data.
- Expose `browser_tool` to the LLM (role `tools` allowlist).
- Ensure scope allowlisting is checked before navigation.
- Status: spec recorded — awaiting implementation.

### T12 — Cyber Tools Bridge & Scope Enforcement (hypothesis, user-agreed)
- Query `tools_config.json`, filter by phase, enforce human-in-the-loop for exploitation phases, and log all executions to the audit trail.
- **Overlap note:** T8 already implements the bridge *execution* path (`cyber_tool run_action`, `bridges.json`, fail-closed `cyberTools` allowlist). T12 covers the harness-side *policy* layer only (phase filtering, HITL for exploit phases, audit logging) — do not build a second dispatch mechanism. `tools_config.json` does not exist yet (T8 uses `bridges.json`); reconcile the config source at implementation.
- Status: spec recorded — awaiting implementation.

Env knobs: `CAS_FILE_HISTORY_DEPTH=3`, `CAS_TTL_MS=86400000`.

## Key constraints
- T7 guard must whitelist internal CAS restore/undo (only validates `patches[].filePath` from LLM).
- Legacy `<ws>/harness/*.yaml|.yml` stays a protected-scope candidate (T7).
- Pre-existing dirty `package-lock.json` — don't touch.
