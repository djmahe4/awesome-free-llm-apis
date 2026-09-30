/**
 * In-process registry of detached long-running processes a harness step
 * attached to via gatedDetach (P5, docs/plans/2026-09-29-harness-p5-monitor-
 * tool.md). Deliberately its OWN small registry, not RunRegistry
 * (pipeline/middlewares/RunRegistry.ts) — that class's RunInfo shape
 * (promptId/lastSubtask/completedCount/totalCount) is fixed to
 * AgenticMiddleware's own subtask-queue semantics, not a generic key-value
 * store; bending it to hold monitor entries would either fight its typed
 * shape or silently reuse fields for an unrelated meaning. In-memory only,
 * same "no new persistence format" posture as the plan intended — this is
 * a second Map alongside RunRegistry's, not a new file format.
 */

export interface MonitorEntry {
  monitorId: string;
  runId: string;
  workspaceRoot?: string;
  role: string;
  tool: string;
  handle: string;
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  updatedAt: number;
  progress?: { completed: number; total?: number; lastEvent?: string };
  result?: unknown;
  error?: string;
}

const monitors = new Map<string, MonitorEntry>();

export class MonitorRegistry {
  static attach(monitorId: string, runId: string, role: string, tool: string, handle: string, workspaceRoot?: string): MonitorEntry {
    const entry: MonitorEntry = { monitorId, runId, workspaceRoot, role, tool, handle, status: 'running', startedAt: Date.now(), updatedAt: Date.now() };
    monitors.set(monitorId, entry);
    return entry;
  }

  static get(monitorId: string): MonitorEntry | undefined {
    return monitors.get(monitorId);
  }

  /** Debounced by the caller (reportProgress's own callers, per D3/risk 1) — this registry itself doesn't rate-limit. */
  static reportProgress(monitorId: string, progress: { completed: number; total?: number; lastEvent?: string }): MonitorEntry | undefined {
    const entry = monitors.get(monitorId);
    if (!entry || entry.status !== 'running') return entry;
    entry.progress = progress;
    entry.updatedAt = Date.now();
    return entry;
  }

  static finish(monitorId: string, result?: unknown, error?: string): MonitorEntry | undefined {
    const entry = monitors.get(monitorId);
    if (!entry) return undefined;
    entry.status = error ? 'failed' : 'done';
    entry.result = result;
    entry.error = error;
    entry.updatedAt = Date.now();
    return entry;
  }

  /**
   * D5 orphan marking — NOT a boot hook (correction from this function's
   * original design note): this Map is in-memory only and starts empty
   * every process start, so a real server restart has nothing left in it
   * to reconcile by the time this process's own startup code could call
   * it — that would be a no-op dressed up as a fix. run.json's own
   * boot reconciliation (store.ts's reconcileRunsOnBoot) is the real one,
   * since run.json persists to disk across restarts and this Map doesn't.
   * This stays useful as a manually-triggerable admin action or for tests
   * that hold a stale in-memory reference across some other lifecycle
   * event — not for the restart case D5 originally described.
   */
  static markAllOrphaned(): MonitorEntry[] {
    const orphaned: MonitorEntry[] = [];
    for (const entry of monitors.values()) {
      if (entry.status === 'running') {
        entry.status = 'failed';
        entry.error = 'orphaned on restart';
        entry.updatedAt = Date.now();
        orphaned.push(entry);
      }
    }
    return orphaned;
  }
}
