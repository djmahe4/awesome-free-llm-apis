import { promises as fs, existsSync } from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { withFileLock } from '../utils/file-lock.js';
import { quantumCompressWithAnchors } from '../utils/quantum-compression.js';
import type { ApprovalRequest, HarnessRun, TraceEvent } from './types.js';

const MAX_TRACE_FILE_BYTES = 5 * 1024 * 1024; // 5MB per run — trace bloat guard (plan risk 8)
const TRACE_DATA_COMPRESS_THRESHOLD_CHARS = 2000;

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Rejects a runId that could escape the harness directory (e.g. `../../etc`) before it's ever used in a path.join. */
function assertSafeRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Invalid runId '${runId}': must match ${RUN_ID_PATTERN} (no path separators or traversal)`);
  }
}

function runDir(baseDir: string, runId: string): string {
  assertSafeRunId(runId);
  const base = path.resolve(baseDir, '.free-llm-mcp', 'harness');
  const dir = path.resolve(base, runId);
  // Belt-and-suspenders: even a runId that passes the charset check couldn't
  // resolve outside `base` given the pattern above, but this is the actual
  // invariant the fix needs to hold, not just the pattern that happens to imply it.
  if (dir !== base && !dir.startsWith(base + path.sep)) {
    throw new Error(`Invalid runId '${runId}': resolves outside the harness directory`);
  }
  return dir;
}

async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) await fs.mkdir(dir, { recursive: true });
}

export class HarnessStore {
  private dir: string;
  private runPath: string;
  private approvalsPath: string;
  private tracePath: string;
  private tasksPath: string;
  private seqCounter: number | null = null;
  private truncationMarked = false;

  constructor(runId: string, baseDir?: string) {
    this.dir = runDir(baseDir ?? process.cwd(), runId);
    this.runPath = path.join(this.dir, 'run.json');
    this.approvalsPath = path.join(this.dir, 'approvals.json');
    this.tracePath = path.join(this.dir, 'trace.jsonl');
    this.tasksPath = path.join(this.dir, 'tasks.md');
  }

  /**
   * Reuses coding_agents' exact tasks.md format/blackboard convention (see
   * src/tools/coding-agents.ts's serializeTasksMarkdown/parseTasksMarkdown,
   * exported for this) for tracking subagent/role invocations across a run
   * — same per-task append-only log, same pending/in_progress/completed/
   * failed status semantics, same reason a failed attempt stays 'pending'
   * rather than 'completed' so the next resume retries it.
   */
  async saveTasksMarkdown(content: string): Promise<void> {
    await ensureDir(this.dir);
    await withFileLock(this.tasksPath, async () => {
      await fs.writeFile(this.tasksPath, content, 'utf-8');
    });
  }

  async loadTasksMarkdown(): Promise<string | null> {
    try {
      return await fs.readFile(this.tasksPath, 'utf-8');
    } catch {
      return null;
    }
  }

  async saveRun(run: HarnessRun): Promise<void> {
    await ensureDir(this.dir);
    await withFileLock(this.runPath, async () => {
      await fs.writeFile(this.runPath, JSON.stringify(run, null, 2), 'utf-8');
    });
  }

  async loadRun(): Promise<HarnessRun | null> {
    try {
      return JSON.parse(await fs.readFile(this.runPath, 'utf-8')) as HarnessRun;
    } catch {
      return null;
    }
  }

  private async loadApprovalsUnsafe(): Promise<ApprovalRequest[]> {
    try {
      return JSON.parse(await fs.readFile(this.approvalsPath, 'utf-8')) as ApprovalRequest[];
    } catch {
      return [];
    }
  }

  /**
   * Every approvals.json read-modify-write goes through here, with the READ
   * inside the same lock as the WRITE — this is the actual fix for a real
   * bug: the previous version only locked the write, so two concurrent
   * mutations (e.g. a human's `reject` racing the runner's `createApproval`)
   * both read the same pre-mutation list and the later write silently
   * discarded the earlier one — a lost rejection meant "no" didn't stick.
   */
  private async mutateApprovals<T>(fn: (list: ApprovalRequest[]) => T): Promise<T> {
    await ensureDir(this.dir);
    return withFileLock(this.approvalsPath, async () => {
      const list = await this.loadApprovalsUnsafe();
      const result = fn(list);
      await fs.writeFile(this.approvalsPath, JSON.stringify(list, null, 2), 'utf-8');
      return result;
    });
  }

  async createApproval(input: Omit<ApprovalRequest, 'id' | 'status' | 'createdAt'>): Promise<ApprovalRequest> {
    const req: ApprovalRequest = {
      ...input,
      id: crypto.randomUUID(),
      status: 'pending',
      createdAt: Date.now(),
    };
    await this.mutateApprovals(list => { list.push(req); });
    return req;
  }

  async listApprovals(): Promise<ApprovalRequest[]> {
    return this.loadApprovalsUnsafe();
  }

  /** Binds strictly to id — the approval only ever authorizes the exact call it was created for (runId+callId+argsHash), never re-matched by tool name alone. */
  async decideApproval(id: string, approve: boolean, decidedBy?: string, note?: string): Promise<ApprovalRequest | null> {
    return this.mutateApprovals(list => {
      const req = list.find(a => a.id === id);
      if (!req) return null;
      if (req.status !== 'pending') return req; // already decided/expired — no-op, not an error
      req.status = approve ? 'approved' : 'rejected';
      req.decidedAt = Date.now();
      req.decidedBy = decidedBy;
      req.note = note;
      return req;
    });
  }

  /** Expires pending approvals older than timeoutMinutes; call opportunistically before checking approval state. */
  async expireStale(timeoutMinutes: number): Promise<void> {
    if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) return; // malformed declaration — fail closed (don't expire) rather than NaN-cutoff never expiring silently
    const cutoff = Date.now() - timeoutMinutes * 60_000;
    await this.mutateApprovals(list => {
      for (const req of list) {
        if (req.status === 'pending' && req.createdAt < cutoff) req.status = 'expired';
      }
    });
  }

  async findApprovedFor(runId: string, callId: string, argsHash: string): Promise<ApprovalRequest | null> {
    const list = await this.loadApprovalsUnsafe();
    return list.find(a => a.runId === runId && a.callId === callId && a.argsHash === argsHash && a.status === 'approved') ?? null;
  }

  async appendTrace(event: Omit<TraceEvent, 'seq' | 'ts'>): Promise<void> {
    await ensureDir(this.dir);
    await withFileLock(this.tracePath, async () => {
      let size = 0;
      try {
        size = (await fs.stat(this.tracePath)).size;
      } catch { /* file doesn't exist yet */ }
      if (size > MAX_TRACE_FILE_BYTES) {
        // Previously a silent drop — a consumer reading the trace had no way
        // to tell "nothing happened" apart from "events happened but were
        // dropped." Write exactly one marker (not one per subsequent dropped
        // event, which would itself blow past the cap) and surface it to the
        // server's own logs too, so it's observable without having to read
        // this specific trace.jsonl file.
        if (!this.truncationMarked) {
          this.truncationMarked = true;
          const marker = `${event.runId}\ttrace truncated at ${MAX_TRACE_FILE_BYTES} bytes — further events are dropped`;
          console.error(`[agent_harness] ${marker}`);
          try {
            await fs.appendFile(this.tracePath, JSON.stringify({
              runId: event.runId, seq: this.seqCounter ?? -1, ts: Date.now(), role: 'top_level',
              type: 'trace_truncated', data: { maxBytes: MAX_TRACE_FILE_BYTES },
            }) + '\n', 'utf-8').catch(() => {});
          } catch { /* best-effort marker write past the cap */ }
        }
        return;
      }

      if (this.seqCounter === null) {
        // Seed once from disk, then keep it in memory — re-reading and
        // re-splitting the whole trace file on every single append was
        // O(n²) over a run's lifetime (a re-read that grows with the file,
        // repeated once per event).
        try {
          const existing = await fs.readFile(this.tracePath, 'utf-8');
          this.seqCounter = existing.split('\n').filter(Boolean).length;
        } catch {
          this.seqCounter = 0;
        }
      }
      const seq = this.seqCounter++;

      const data = event.data;
      // Sliding-window / quantum compression instead of a blind char-count
      // truncation: reuses the same anchor-preserving compressor manage_memory
      // already uses for oversized search results (quantumCompressWithAnchors)
      // so a long tool-result payload keeps the sentences most relevant to
      // this event (tool name, role, event type as anchors) instead of just
      // losing everything past an arbitrary character cutoff.
      const compressedData = typeof data === 'string' && data.length > TRACE_DATA_COMPRESS_THRESHOLD_CHARS
        ? quantumCompressWithAnchors(data, [event.role, event.type, String((event as any).tool ?? '')], 0.5)
        : data;

      const full: TraceEvent = { ...event, data: compressedData, seq, ts: Date.now() };
      await fs.appendFile(this.tracePath, JSON.stringify(full) + '\n', 'utf-8');
    });
  }

  async readTrace(limit = 200): Promise<TraceEvent[]> {
    try {
      const raw = await fs.readFile(this.tracePath, 'utf-8');
      const lines = raw.split('\n').filter(Boolean);
      return lines.slice(-limit).map(l => JSON.parse(l) as TraceEvent);
    } catch {
      return [];
    }
  }
}
