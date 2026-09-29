import { promises as fs, existsSync } from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { withFileLock } from '../utils/file-lock.js';
import type { ApprovalRequest, HarnessRun, TraceEvent } from './types.js';

const MAX_TRACE_FILE_BYTES = 5 * 1024 * 1024; // 5MB per run — trace bloat guard (plan risk 8)
const TRACE_DATA_TRUNCATE_CHARS = 4000;

function runDir(baseDir: string, runId: string): string {
  return path.join(baseDir, '.free-llm-mcp', 'harness', runId);
}

async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) await fs.mkdir(dir, { recursive: true });
}

export class HarnessStore {
  private dir: string;
  private runPath: string;
  private approvalsPath: string;
  private tracePath: string;

  constructor(runId: string, baseDir?: string) {
    this.dir = runDir(baseDir ?? process.cwd(), runId);
    this.runPath = path.join(this.dir, 'run.json');
    this.approvalsPath = path.join(this.dir, 'approvals.json');
    this.tracePath = path.join(this.dir, 'trace.jsonl');
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

  private async loadApprovals(): Promise<ApprovalRequest[]> {
    try {
      return JSON.parse(await fs.readFile(this.approvalsPath, 'utf-8')) as ApprovalRequest[];
    } catch {
      return [];
    }
  }

  private async saveApprovals(list: ApprovalRequest[]): Promise<void> {
    await ensureDir(this.dir);
    await withFileLock(this.approvalsPath, async () => {
      await fs.writeFile(this.approvalsPath, JSON.stringify(list, null, 2), 'utf-8');
    });
  }

  async createApproval(input: Omit<ApprovalRequest, 'id' | 'status' | 'createdAt'>): Promise<ApprovalRequest> {
    const req: ApprovalRequest = {
      ...input,
      id: crypto.randomUUID(),
      status: 'pending',
      createdAt: Date.now(),
    };
    const list = await this.loadApprovals();
    list.push(req);
    await this.saveApprovals(list);
    return req;
  }

  async listApprovals(): Promise<ApprovalRequest[]> {
    return this.loadApprovals();
  }

  /** Binds strictly to id — the approval only ever authorizes the exact call it was created for (runId+callId+argsHash), never re-matched by tool name alone. */
  async decideApproval(id: string, approve: boolean, decidedBy?: string, note?: string): Promise<ApprovalRequest | null> {
    const list = await this.loadApprovals();
    const req = list.find(a => a.id === id);
    if (!req) return null;
    if (req.status !== 'pending') return req; // already decided/expired — no-op, not an error
    req.status = approve ? 'approved' : 'rejected';
    req.decidedAt = Date.now();
    req.decidedBy = decidedBy;
    req.note = note;
    await this.saveApprovals(list);
    return req;
  }

  /** Expires pending approvals older than timeoutMinutes; call opportunistically before checking approval state. */
  async expireStale(timeoutMinutes: number): Promise<void> {
    const list = await this.loadApprovals();
    const cutoff = Date.now() - timeoutMinutes * 60_000;
    let changed = false;
    for (const req of list) {
      if (req.status === 'pending' && req.createdAt < cutoff) {
        req.status = 'expired';
        changed = true;
      }
    }
    if (changed) await this.saveApprovals(list);
  }

  async findApprovedFor(runId: string, callId: string, argsHash: string): Promise<ApprovalRequest | null> {
    const list = await this.loadApprovals();
    return list.find(a => a.runId === runId && a.callId === callId && a.argsHash === argsHash && a.status === 'approved') ?? null;
  }

  async appendTrace(event: Omit<TraceEvent, 'seq' | 'ts'>): Promise<void> {
    await ensureDir(this.dir);
    await withFileLock(this.tracePath, async () => {
      let size = 0;
      try {
        size = (await fs.stat(this.tracePath)).size;
      } catch { /* file doesn't exist yet */ }
      if (size > MAX_TRACE_FILE_BYTES) return; // trace bloat guard — drop further events rather than grow unbounded

      let seq = 0;
      try {
        const existing = await fs.readFile(this.tracePath, 'utf-8');
        seq = existing.split('\n').filter(Boolean).length;
      } catch { /* first event */ }

      const data = event.data;
      const truncatedData = typeof data === 'string' && data.length > TRACE_DATA_TRUNCATE_CHARS
        ? data.slice(0, TRACE_DATA_TRUNCATE_CHARS) + `…[truncated ${data.length - TRACE_DATA_TRUNCATE_CHARS} chars]`
        : data;

      const full: TraceEvent = { ...event, data: truncatedData, seq, ts: Date.now() };
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
