import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

export interface ProbeResult {
  status: 'confirmed' | 'refuted' | 'open';
  evidence: string;
}

export interface CacheEntry {
  result: ProbeResult;
  timestamp: number;
}

export const DEFAULT_PROBE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const DEFAULT_PROBE_CACHE_MAX_ENTRIES = 1000;
export const RELATIVE_PROBE_CACHE_PATH = path.join('.free-llm-mcp', 'episodic', 'probe-cache.json');

export function makeProbeCacheKey(filePath: string, hash: string, probe: string): string {
  return `${filePath}\0${hash}\0${probe}`;
}

export interface EpisodicProbeCacheOptions {
  workspaceRoot?: string;
  cachePath?: string;
  maxEntries?: number;
  ttlMs?: number;
}

export class EpisodicProbeCache {
  private cache = new Map<string, CacheEntry>();
  readonly maxEntries: number;
  readonly ttlMs: number;
  private cachePath: string;

  constructor(options?: string | EpisodicProbeCacheOptions) {
    if (typeof options === 'string') {
      this.maxEntries = DEFAULT_PROBE_CACHE_MAX_ENTRIES;
      this.ttlMs = DEFAULT_PROBE_CACHE_TTL_MS;
      this.cachePath = options.endsWith('.json')
        ? path.resolve(options)
        : path.resolve(options, RELATIVE_PROBE_CACHE_PATH);
    } else {
      this.maxEntries = options?.maxEntries ?? DEFAULT_PROBE_CACHE_MAX_ENTRIES;
      this.ttlMs = options?.ttlMs ?? DEFAULT_PROBE_CACHE_TTL_MS;
      if (options?.cachePath) {
        this.cachePath = path.resolve(options.cachePath);
      } else if (options?.workspaceRoot) {
        this.cachePath = path.resolve(options.workspaceRoot, RELATIVE_PROBE_CACHE_PATH);
      } else {
        this.cachePath = path.resolve(process.cwd(), RELATIVE_PROBE_CACHE_PATH);
      }
    }
  }

  getCachePath(): string {
    return this.cachePath;
  }

  setCachePath(p: string): void {
    this.cachePath = path.resolve(p);
  }

  static makeKey(filePath: string, hash: string, probe: string): string {
    return makeProbeCacheKey(filePath, hash, probe);
  }

  makeKey(filePath: string, hash: string, probe: string): string {
    return makeProbeCacheKey(filePath, hash, probe);
  }

  get size(): number {
    return this.cache.size;
  }

  get(key: string): ProbeResult | undefined;
  get(filePath: string, hash: string, probe: string): ProbeResult | undefined;
  get(filePathOrKey: string, hash?: string, probe?: string): ProbeResult | undefined {
    const key = hash !== undefined && probe !== undefined
      ? makeProbeCacheKey(filePathOrKey, hash, probe)
      : filePathOrKey;

    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    // Refresh LRU order on hit
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.result;
  }

  getEntry(key: string): CacheEntry | undefined;
  getEntry(filePath: string, hash: string, probe: string): CacheEntry | undefined;
  getEntry(filePathOrKey: string, hash?: string, probe?: string): CacheEntry | undefined {
    const key = hash !== undefined && probe !== undefined
      ? makeProbeCacheKey(filePathOrKey, hash, probe)
      : filePathOrKey;

    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    return entry;
  }

  has(key: string): boolean;
  has(filePath: string, hash: string, probe: string): boolean;
  has(filePathOrKey: string, hash?: string, probe?: string): boolean {
    return this.get(filePathOrKey as any, hash as any, probe as any) !== undefined;
  }

  set(key: string, result: ProbeResult, timestamp?: number): this;
  set(filePath: string, hash: string, probe: string, result: ProbeResult, timestamp?: number): this;
  set(
    filePathOrKey: string,
    hashOrResult: string | ProbeResult,
    probeOrTimestamp?: string | number,
    result?: ProbeResult,
    customTimestamp?: number,
  ): this {
    let key: string;
    let res: ProbeResult;
    let ts: number;

    if (typeof hashOrResult === 'string' && typeof probeOrTimestamp === 'string' && result !== undefined) {
      key = makeProbeCacheKey(filePathOrKey, hashOrResult, probeOrTimestamp);
      res = result;
      ts = typeof customTimestamp === 'number' ? customTimestamp : Date.now();
    } else if (typeof hashOrResult === 'object' && hashOrResult !== null) {
      key = filePathOrKey;
      res = hashOrResult as ProbeResult;
      ts = typeof probeOrTimestamp === 'number' ? probeOrTimestamp : Date.now();
    } else {
      throw new Error('Invalid arguments to EpisodicProbeCache.set');
    }

    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    this.cache.set(key, { result: res, timestamp: ts });

    while (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      } else {
        break;
      }
    }

    return this;
  }

  delete(key: string): boolean;
  delete(filePath: string, hash: string, probe: string): boolean;
  delete(filePathOrKey: string, hash?: string, probe?: string): boolean {
    const key = hash !== undefined && probe !== undefined
      ? makeProbeCacheKey(filePathOrKey, hash, probe)
      : filePathOrKey;
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttlMs) {
        this.cache.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  async flush(targetPath?: string): Promise<void> {
    const dest = path.resolve(targetPath || this.cachePath);
    this.pruneExpired();
    const data: Record<string, { result: ProbeResult; timestamp: number }> = {};
    for (const [key, entry] of this.cache.entries()) {
      data[key] = {
        result: entry.result,
        timestamp: entry.timestamp,
      };
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, JSON.stringify(data, null, 2), 'utf-8');
  }

  async load(targetPath?: string): Promise<void> {
    const src = path.resolve(targetPath || this.cachePath);
    let content: string;
    try {
      content = await fs.readFile(src, 'utf-8');
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return;
      }
      throw err;
    }

    this.parseAndLoad(content);
  }

  flushSync(targetPath?: string): void {
    const dest = path.resolve(targetPath || this.cachePath);
    this.pruneExpired();
    const data: Record<string, { result: ProbeResult; timestamp: number }> = {};
    for (const [key, entry] of this.cache.entries()) {
      data[key] = {
        result: entry.result,
        timestamp: entry.timestamp,
      };
    }
    fsSync.mkdirSync(path.dirname(dest), { recursive: true });
    fsSync.writeFileSync(dest, JSON.stringify(data, null, 2), 'utf-8');
  }

  loadSync(targetPath?: string): void {
    const src = path.resolve(targetPath || this.cachePath);
    let content: string;
    try {
      content = fsSync.readFileSync(src, 'utf-8');
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return;
      }
      throw err;
    }

    this.parseAndLoad(content);
  }

  private parseAndLoad(jsonString: string): void {
    const parsed = JSON.parse(jsonString);
    this.cache.clear();
    const now = Date.now();

    if (!parsed || typeof parsed !== 'object') return;

    const entries: Array<[string, any]> = Array.isArray(parsed)
      ? parsed
      : Object.entries(
          parsed.entries && typeof parsed.entries === 'object' && !('status' in parsed.entries)
            ? parsed.entries
            : parsed,
        );

    for (const [key, val] of entries) {
      if (!val || typeof val !== 'object') continue;
      const ts = typeof val.timestamp === 'number' ? val.timestamp : now;
      if (now - ts > this.ttlMs) continue;

      const result: ProbeResult = val.result && typeof val.result === 'object'
        ? val.result
        : {
            status: val.status ?? 'open',
            evidence: val.evidence ?? '',
          };

      this.cache.set(key, { result, timestamp: ts });
      while (this.cache.size > this.maxEntries) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
        else break;
      }
    }
  }
}

export const globalEpisodicCache = new EpisodicProbeCache();
