import { quantumCompressWithAnchors, quantumCompress } from '../utils/quantum-compression.js';

export interface CacheEntry {
  value: unknown;
  expiresAt: number;
  updatedAt: number;
  createdAt: number;
  accessCount: number;
  stabilityMs: number;
}

export class ShortTermMemory {
  private cache: Map<string, CacheEntry> = new Map();
  private defaultTtlMs: number;
  private maxEntries: number;
  private lastPruneTime = 0;

  constructor(defaultTtlMs = 30 * 60 * 1000, maxEntries = 1000) {
    this.defaultTtlMs = defaultTtlMs;
    this.maxEntries = maxEntries;
  }

  /**
   * Calculates Ebbinghaus retention R = exp(-deltaT / S).
   * Range [0..1], where 1.0 is freshly accessed and 0.0 is completely forgotten.
   */
  calculateRetention(entry: CacheEntry, now = Date.now()): number {
    const elapsed = Math.max(0, now - entry.updatedAt);
    const s = Math.max(1000, entry.stabilityMs);
    if (isNaN(elapsed) || isNaN(s)) return 0;
    return Math.exp(-elapsed / s);
  }

  set(key: string, value: unknown, ttlMs?: number): void {
    const now = Date.now();
    const effectiveTtl = ttlMs ?? this.defaultTtlMs;

    // Graceful Ebbinghaus prune throttle: prune at most every 60s under normal operation
    if (now - this.lastPruneTime > 60000) {
      this.prune();
    }

    // Capacity eviction based on lowest Ebbinghaus retention score
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      let lowestRetentionKey: string | undefined;
      let lowestRetentionScore = Infinity;

      for (const [k, entry] of this.cache.entries()) {
        const r = this.calculateRetention(entry, now);
        if (r < lowestRetentionScore) {
          lowestRetentionScore = r;
          lowestRetentionKey = k;
        }
      }

      if (lowestRetentionKey !== undefined) {
        this.cache.delete(lowestRetentionKey);
      } else {
        const firstKey = this.cache.keys().next().value;
        if (firstKey !== undefined) this.cache.delete(firstKey);
      }
    }

    const existing = this.cache.get(key);
    const accessCount = existing ? existing.accessCount + 1 : 1;
    // Initial stability is proportional to half the TTL, increasing with repeat sets
    const baseStability = effectiveTtl / 2;
    const stabilityMs = existing
      ? existing.stabilityMs * 1.5
      : baseStability;

    const expiresAt = now + effectiveTtl;
    this.cache.set(key, {
      value,
      expiresAt,
      updatedAt: now,
      createdAt: existing ? existing.createdAt : now,
      accessCount,
      stabilityMs,
    });
  }

  get(key: string): unknown | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    const now = Date.now();

    // Check hard expiry
    if (now > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    // Ebbinghaus decay evaluation: if retention dropped below critical threshold (e.g. 0.05), forget
    const retention = this.calculateRetention(entry, now);
    if (retention < 0.05) {
      this.cache.delete(key);
      return undefined;
    }

    // Hit reinforcement: repeated retrieval strengthens memory stability (Ebbinghaus consolidation)
    entry.accessCount += 1;
    entry.stabilityMs = Math.min(entry.stabilityMs * 1.5, this.defaultTtlMs * 4);
    entry.expiresAt = Math.max(entry.expiresAt, now + Math.round(entry.stabilityMs * 3));
    entry.updatedAt = now;

    return entry.value;
  }

  /**
   * Retrieves an entry and applies keyword-anchored quantum compression if text.
   * Sentences matching keywords remain intact; remaining sentences are compressed.
   */
  getCompressed(key: string, keywords: string[] = [], temperature = 0.6): unknown | undefined {
    const raw = this.get(key);
    if (typeof raw !== 'string') return raw;
    if (keywords.length === 0) {
      return quantumCompress(raw, temperature);
    }
    return quantumCompressWithAnchors(raw, keywords, temperature);
  }

  getByPrefix(prefix: string): Array<{ key: string; value: unknown }> {
    this.prune();
    const results: Array<{ key: string; value: unknown }> = [];
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (key.startsWith(prefix) && now <= entry.expiresAt) {
        results.push({ key, value: entry.value });
      }
    }
    return results;
  }

  getRecentEntries(limit = 10): Array<{ key: string; value: unknown }> {
    this.prune();
    const now = Date.now();
    const validEntries: Array<{ key: string; value: unknown; updatedAt: number; retention: number }> = [];
    for (const [key, entry] of this.cache.entries()) {
      if (now <= entry.expiresAt) {
        const retention = this.calculateRetention(entry, now);
        if (retention >= 0.05) {
          validEntries.push({ key, value: entry.value, updatedAt: entry.updatedAt ?? 0, retention });
        }
      }
    }
    return validEntries
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map(e => ({ key: e.key, value: e.value }));
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  /**
   * Prunes entries that have expired or decayed below retention threshold (R < 0.05).
   */
  prune(): void {
    const now = Date.now();
    this.lastPruneTime = now;
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        continue;
      }
      const r = this.calculateRetention(entry, now);
      if (r < 0.05) {
        this.cache.delete(key);
      }
    }
  }

  size(): number {
    return this.cache.size;
  }

  /**
   * Inspection helper for debugging retention scores.
   */
  getEntryMeta(key: string): Omit<CacheEntry, 'value'> & { retention: number } | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    return {
      expiresAt: entry.expiresAt,
      updatedAt: entry.updatedAt,
      createdAt: entry.createdAt,
      accessCount: entry.accessCount,
      stabilityMs: entry.stabilityMs,
      retention: Math.round(this.calculateRetention(entry) * 1000) / 1000,
    };
  }
}
