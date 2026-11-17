/**
 * VRAM concurrency gate / lock for local offline model invocations.
 * Prevents multiple parallel model loads into VRAM across hypothesis loops,
 * local-llm-patch, cyber-tool local calls, etc.
 */

export class LocalModelLock {
  private static instance: LocalModelLock;
  private locked = false;
  private waitQueue: Array<() => void> = [];

  public static getInstance(): LocalModelLock {
    if (!LocalModelLock.instance) {
      LocalModelLock.instance = new LocalModelLock();
    }
    return LocalModelLock.instance;
  }

  /**
   * Acquire execution lock for a local model run.
   * If already locked, waits until previous caller releases it.
   */
  public async acquire(timeoutMs = 120_000, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new Error('LocalModelLock acquire aborted before start');
    }

    if (!this.locked) {
      this.locked = true;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          this.release();
        }
      };
    }

    return new Promise<() => void>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      let onAbort: (() => void) | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      };

      const tryAcquire = () => {
        cleanup();
        this.locked = true;
        let released = false;
        resolve(() => {
          if (!released) {
            released = true;
            this.release();
          }
        });
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const idx = this.waitQueue.indexOf(tryAcquire);
          if (idx !== -1) {
            this.waitQueue.splice(idx, 1);
          }
          cleanup();
          reject(new Error(`Timed out waiting for local model lock after ${timeoutMs}ms (VRAM guard)`));
        }, timeoutMs);
      }

      if (signal) {
        onAbort = () => {
          const idx = this.waitQueue.indexOf(tryAcquire);
          if (idx !== -1) {
            this.waitQueue.splice(idx, 1);
          }
          cleanup();
          reject(new Error('LocalModelLock acquire aborted'));
        };
        signal.addEventListener('abort', onAbort);
      }

      this.waitQueue.push(tryAcquire);
    });
  }

  /**
   * Execute task with lock acquired, releasing on completion or throw.
   */
  public async runWithLock<T>(fn: () => Promise<T>, timeoutMs = 120_000, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(timeoutMs, signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  public isLocked(): boolean {
    return this.locked;
  }

  public getQueueLength(): number {
    return this.waitQueue.length;
  }

  private release(): void {
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      if (next) {
        next();
        return;
      }
    }
    this.locked = false;
  }
}
