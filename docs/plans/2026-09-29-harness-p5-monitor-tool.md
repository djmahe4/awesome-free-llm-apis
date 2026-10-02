# Plan — Harness P5: monitor-tool for detached long-running processes

Branch: `feat/agent-harness`
Builds on: [2026-09-29-agent-harness.md](2026-09-29-agent-harness.md) (P0–P3), [2026-09-29-harness-p4-subagents-brain.md](2026-09-29-harness-p4-subagents-brain.md) (P4, step engine/handoff — not yet implemented, see that doc's phases).
Origin: `mcp-server/docs/harness-cyber.md`'s replicability table — "Monitor-tool for scanner/fuzzer supervision: (c) new runner.ts + new tool — `gatedCall` awaits one promise to completion, no attach/poll/ready-gate concept." Explicitly scoped out of the priority-1–5 fix list as separate, larger effort.

## Goal

A way for a harness role (scraper/coder, primarily) to kick off a long-running process — a fuzzer, a scanner, a multi-minute scrape — without `gatedCall` blocking the whole run on one `await`, while staying inside the existing default-deny/trace/approval architecture. Not a job scheduler: no cron, no distributed workers, no retry policy beyond what `coding_agents`-style guards already do elsewhere.

## Non-goals

- Not a general async task queue. One detached child per `monitorId`, no fan-out (that's a separate, larger P5+ item per the same replicability table).
- Not a new persistence format. Reuses `RunRegistry` (in-memory, already used for `harness:<runId>` keys) and the run's existing `trace.jsonl`.
- Not a new approval mechanism. A monitored run that needs human judgment mid-flight uses the *existing* approval queue, just with a `monitorId` in the request's `args` for context.

## Design

### D1. `gatedDetach` — sibling to `gatedCall`, not a replacement

`gatedCall` (runner.ts) does: reserve budget → `policy.evaluate` → on allow, `await execute()` → settle budget → trace `tool_result`. That's correct for anything that finishes in one LLM/tool round trip.

`gatedDetach(store, run, decl, role, tool, action, args, estimate, callId, start: () => Promise<{ handle: string }>)`:
1. Same budget reserve + `policy.evaluate` as `gatedCall` — a detached process still needs an allow/approval decision before it starts, no exception.
2. On allow: call `start()`, which kicks off the process and returns immediately with a `handle` (whatever the underlying tool considers its own run id — e.g. `cyber_tool`'s existing `osintRunKey` pattern is the precedent, see `cyber-tool.ts` around `run.completedCount`/`run.done`).
3. Register `RunRegistry.set('monitor:' + run.runId + ':' + callId, { handle, tool, startedAt: Date.now(), status: 'running' })`.
4. Trace a `tool_call` event same as `gatedCall`, plus a new `monitor_attached` event with `{ monitorId: callId, handle }`.
5. Return `{ ok: true, kind: 'attached', monitorId: callId }` — does NOT settle budget yet (nothing spent besides the attach call itself); budget for the detached work settles incrementally as it reports progress (D3).

### D2. Poll surface — reuse the `cyber_tool` osint-poll pattern, don't invent one

`cyber_tool`'s `osint_poll` action (`cyber-tool.ts`, the `run.done`/`run.completedCount`/`run.lastSubtask` shape) is the exact precedent: check `RunRegistry.get(key)`, report `running`/`done`, surface partial progress. `monitor_tool` (new, small MCP tool) does the same against `monitor:<runId>:<callId>` keys:

```ts
interface MonitorPollResult {
  monitorId: string;
  status: 'running' | 'done' | 'failed';
  progress?: { completed: number; total?: number; lastEvent?: string };
  result?: unknown;   // only when status === 'done'
  error?: string;      // only when status === 'failed'
}
```

No new store file — `RunRegistry` already holds this shape of thing in memory for the run's lifetime, matching how `harness:<runId>` itself is tracked.

### D3. Progress → trace, budget settles incrementally

Whatever underlying process `start()` wraps (fuzzer, scanner) is expected to periodically call back into a small `reportProgress(monitorId, event)` helper — same shape as `cyber_tool`'s `osintResultsCache`/`completedCount` updates. Each call:
- Updates the `RunRegistry` entry.
- Appends a `monitor_progress` trace event (bounded — same per-event truncation as every other trace event; no unbounded growth risk beyond what already exists).
- If the event reports token/resource usage, settles that increment against `run.budget.used` the same way `gatedCall`'s `finally` block does — so a long monitored run can still trip `paused_budget` mid-flight, it isn't exempt from the budget model just because it's detached.

### D4. Human intervention = existing approval queue, not a new interrupt

When the monitored process itself decides it needs a decision (candidate crash found, ambiguous result), it doesn't get a new "pause" primitive — it creates an `ApprovalRequest` exactly like any other gated call would, with `args: { monitorId, ... }` so the approval UI has context. `monitor_tool`'s poll surface will show `status: 'running'` with the pending approval visible via the existing `approvals` action — no new UI concept, no new resume path.

### D5. Termination

- `monitor_tool` action `stop(monitorId)` — policy-gated like any other call (a role that can attach can also stop what it attached; cross-role stop needs approval same as everything else). Underlying `start()` implementations must accept an abort signal (mirrors `browser_tool`'s existing abort-signal passthrough noted in the P4 doc's D1 "Abort is checked between steps").
- Orphaned monitors on server restart: `RunRegistry` is in-memory, so a restart loses the handle. On boot, any `monitor:*` key with no corresponding live process gets marked `failed` with reason `orphaned on restart` and traced — same "never silently lost" posture as `run.json`'s own `running` → `paused` boot reconciliation (P4 doc D1 self-review point, still not implemented for runs either — this is the same fix, applied to monitors too, and should land together).

## Data model additions

```ts
// harness/types.ts additions
interface MonitorEntry {
  monitorId: string; runId: string; tool: string; handle: string;
  status: 'running' | 'done' | 'failed';
  startedAt: number; updatedAt: number;
  progress?: { completed: number; total?: number; lastEvent?: string };
  result?: unknown; error?: string;
}

// TraceEvent.type additions: 'monitor_attached' | 'monitor_progress' | 'monitor_done'
```

## Phases

- **P5a — `gatedDetach` + `monitor_tool` (attach/poll/stop) against a fake process.** Tests: attach returns immediately without blocking; poll reflects progress; stop is policy-gated; orphan-on-restart marks `failed`.
- **P5b — Wire one real detached user**: `cyber_tool`'s existing autonomous-scan actions (the `osint` `autoSearch` path is the closest existing precedent) get an opt-in `detached: true` mode that goes through `gatedDetach` instead of blocking. Not a new capability — same osint pipeline, different await shape.
- **P5c — Budget + approval integration tests.** A detached run that exceeds budget mid-flight pauses; a detached run's internal approval request surfaces through the existing `approvals` action with `monitorId` context.

## Risks

1. **Progress-report spam** — a chatty process floods `trace.jsonl`. → same per-event truncation + per-run size cap already governing every other trace event (P0 plan, risk 8); add a minimum-interval debounce on `reportProgress` (e.g. 1s) as a cheap backstop.
2. **Zombie processes on crash** — server dies, child process (if truly a subprocess, not just an async loop) keeps running. → `start()` implementations must be real Node async work (like `cyber_tool`'s pattern) or use `child_process` with the parent tracking the PID for cleanup on boot reconciliation (D5). No support for detaching to genuinely un-managed external processes in P5a/b.
3. **Budget settlement lag** — a monitor could, in principle, do unbounded work between progress reports before its next budget check-in. → cap the interval between required `reportProgress` calls (same debounce value as risk 1, upper-bounded too) so budget enforcement can't be starved by silence.

## Open questions

1. Is `cyber_tool`'s `osint autoSearch` the right first real user for P5b, or should P5a ship with only a fake/test process and defer any real integration to a separate PR?
2. Should `stop` require approval even for the attaching role's own monitor, or only for cross-role stop? (Plan above assumes same-role stop is self-service, matching how a role can already abort its own `gatedCall` work implicitly by the run ending.)
