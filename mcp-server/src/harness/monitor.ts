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
   * Boot reconciliation (D5) — RunRegistry itself is in-memory, so a server
   * restart silently drops every handle. Anything still 'running' at boot
   * (before any real attach has happened yet in this process) is by
   * definition orphaned from a prior process — never a real live monitor,
   * since this Map is empty until this process attaches something itself.
   * Call once at server startup, mirroring run.json's own
   * running->paused boot reconciliation (still not implemented for runs
   * either — same fix, applied here first).
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
