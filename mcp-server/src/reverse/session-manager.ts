import { ReaProxy, type ReaProxyOptions } from './proxy.js';

export interface SessionManagerOptions {
  idleTimeoutMs?: number;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ActiveSession {
  proxy: ReaProxy;
  lastUsed: number;
  timer: NodeJS.Timeout | null;
}

export class ReaSessionManager {
  public sessions = new Map<string, ActiveSession>();
  private pendingCreations = new Map<string, Promise<ReaProxy>>();
  private readonly defaultCommand: string;
  private readonly defaultArgs: string[];
  private readonly defaultEnv?: Record<string, string>;
  public readonly idleTimeoutMs: number;

  constructor(options: SessionManagerOptions = {}) {
    this.defaultCommand = options.command || process.env.REA_AGENTS_PATH || 'rea';
    this.defaultArgs = options.args || [];
    this.defaultEnv = options.env;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60 * 1000; // 5 min idle default
  }

  public get size(): number {
    return this.sessions.size;
  }

  public hasSession(key: string): boolean {
    return this.sessions.has(key);
  }

  private resetIdleTimer(key: string, session: ActiveSession): void {
    if (session.timer) {
      clearTimeout(session.timer);
    }
    session.timer = setTimeout(async () => {
      try {
        await this.closeSession(key);
      } catch {
        // Ignore background close error
      }
    }, this.idleTimeoutMs);
    if (typeof session.timer?.unref === 'function') {
      session.timer.unref();
    }
  }

  public async getOrCreateSession(key: string, overrideOptions?: Partial<ReaProxyOptions>): Promise<ReaProxy> {
    const existing = this.sessions.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      this.resetIdleTimer(key, existing);
      return existing.proxy;
    }

    const inFlight = this.pendingCreations.get(key);
    if (inFlight) {
      return inFlight;
    }

    const creationPromise = (async () => {
      try {
        const proxy = new ReaProxy({
          command: overrideOptions?.command || this.defaultCommand,
          args: overrideOptions?.args || this.defaultArgs,
          env: overrideOptions?.env || this.defaultEnv,
          requestTimeoutMs: overrideOptions?.requestTimeoutMs,
          handshakeTimeoutMs: overrideOptions?.handshakeTimeoutMs,
          maxResponseBytes: overrideOptions?.maxResponseBytes,
          pins: overrideOptions?.pins,
        });

        await proxy.start();

        const session: ActiveSession = {
          proxy,
          lastUsed: Date.now(),
          timer: null,
        };

        this.resetIdleTimer(key, session);
        this.sessions.set(key, session);
        return proxy;
      } finally {
        this.pendingCreations.delete(key);
      }
    })();

    this.pendingCreations.set(key, creationPromise);
    return creationPromise;
  }

  public async closeSession(key: string): Promise<void> {
    const session = this.sessions.get(key);
    if (session) {
      this.sessions.delete(key);
      if (session.timer) {
        clearTimeout(session.timer);
        session.timer = null;
      }
      await session.proxy.close();
    }
  }

  public async closeAll(): Promise<void> {
    const inFlight = Array.from(this.pendingCreations.values());
    if (inFlight.length > 0) {
      await Promise.allSettled(inFlight);
    }
    const keys = Array.from(this.sessions.keys());
    await Promise.all(keys.map((k) => this.closeSession(k)));
  }
}

// Global default singleton session manager
export const defaultSessionManager = new ReaSessionManager();
