import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import crypto from 'node:crypto';
import { withFileLock } from './file-lock.js';

/**
 * Cross-process provider lock: multiple MCP server processes (separate Node
 * processes, e.g. one per editor window/CLI session) can independently pick the
 * same top-ranked provider for a concurrent request. Without coordination they
 * all hit it at once, which is exactly what the health-based scoring/circuit
 * breaker in LLMExecutor is trying to avoid — it just can't see across
 * processes. This makes "provider X is currently in use" a fact on disk that
 * every process's LLMExecutor checks before calling that provider, so a busy
 * provider gets rerouted to the next candidate instead of piled onto.
 *
 * Deliberately provider-scoped, not provider+model — a rate limit is generally
 * per-provider-account, not finer-grained, and this keeps one busy model from
 * blocking unrelated models on the same provider from ever being tried.
 *
 * Lease-based, not held-until-released-only: a lock also carries an expiresAt
 * so a process that crashes mid-call doesn't wedge that provider for everyone
 * else forever (belt-and-suspenders on top of file-lock.ts's own PID-liveness
 * reaping of the file-lock itself — this expiresAt is about the logical
 * provider claim recorded *inside* the JSON table, not the file lock used to
 * read-modify-write that table). A live call extends its lease via
 * heartbeat() while in flight.
 *
 * Uses this repo's existing withFileLock() (utils/file-lock.ts — atomic
 * fs.writeFile(path,'wx') + PID-liveness stale-reap, the same helper
 * CyberToolsRegistry uses) to serialize the read-modify-write of the shared
 * JSON lock table, rather than reimplementing file locking here.
 */

interface LockEntry {
  holderId: string;
  pid: number;
  sessionId?: string;
  startedAt: number;
  expiresAt: number;
}

type LockTable = Record<string /* providerId */, LockEntry>;

const DEFAULT_LEASE_MS = 20_000;
const FILE_LOCK_TIMEOUT_MS = 3_000;

export class ProviderLockManager {
  private filePath: string;

  constructor(customPath?: string) {
    this.filePath = customPath || this.resolvePath();
  }

  private resolvePath(): string {
    if (process.env.MCP_PROVIDER_LOCKS_PATH) {
      return process.env.MCP_PROVIDER_LOCKS_PATH;
    }
    return path.join(os.homedir(), '.free-llm-mcp', 'provider-locks.json');
  }

  /** Serializes the read-modify-write of the shared lock table across processes. */
  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await withFileLock(this.filePath, fn, FILE_LOCK_TIMEOUT_MS);
    } catch {
      // Timed out waiting for the file lock itself — proceed without it rather
      // than let this coordination mechanism hang the request it's meant to
      // protect. Worst case: a rare lost update to the lock table, not a stuck call.
      return fn();
    }
  }

  private async readLocks(): Promise<LockTable> {
    try {
      return await fs.readJson(this.filePath);
    } catch {
      return {};
    }
  }

  private async writeLocks(locks: LockTable): Promise<void> {
    await fs.ensureDir(path.dirname(this.filePath));
    await fs.writeJson(this.filePath, locks);
  }

  /**
   * Atomically claims providerId if free or its lease has expired. Returns a
   * holderId to pass to heartbeat()/release(), or null if another live holder
   * has it — callers should reroute to the next candidate on null, not wait.
   */
  async tryAcquire(providerId: string, sessionId?: string, leaseMs = DEFAULT_LEASE_MS): Promise<string | null> {
    return this.withFileLock(async () => {
      const locks = await this.readLocks();
      const existing = locks[providerId];
      const now = Date.now();
      if (existing && existing.expiresAt > now) {
        return null;
      }
      const holderId = crypto.randomUUID();
      locks[providerId] = { holderId, pid: process.pid, sessionId, startedAt: now, expiresAt: now + leaseMs };
      await this.writeLocks(locks);
      return holderId;
    });
  }

  /** Extends a held lock's lease — call periodically while the underlying request is still in flight. */
  async heartbeat(providerId: string, holderId: string, leaseMs = DEFAULT_LEASE_MS): Promise<void> {
    await this.withFileLock(async () => {
      const locks = await this.readLocks();
      const existing = locks[providerId];
      if (existing && existing.holderId === holderId) {
        existing.expiresAt = Date.now() + leaseMs;
        await this.writeLocks(locks);
      }
    });
  }

  /** Releases a held lock. No-op if this holderId no longer owns it (already expired and reclaimed). */
  async release(providerId: string, holderId: string): Promise<void> {
    await this.withFileLock(async () => {
      const locks = await this.readLocks();
      const existing = locks[providerId];
      if (existing && existing.holderId === holderId) {
        delete locks[providerId];
        await this.writeLocks(locks);
      }
    });
  }

  /** Live (non-expired) locks — for status/diagnostics surfaces. */
  async listActive(): Promise<Array<{ providerId: string } & LockEntry>> {
    const locks = await this.readLocks();
    const now = Date.now();
    return Object.entries(locks)
      .filter(([, v]) => v.expiresAt > now)
      .map(([providerId, v]) => ({ providerId, ...v }));
  }
}

export const providerLockManager = new ProviderLockManager();
