interface CacheEntry {
  value: unknown;
  expiresAt: number;
  updatedAt: number;
}

export class ShortTermMemory {
  private cache: Map<string, CacheEntry> = new Map();
  private defaultTtlMs: number;

  constructor(defaultTtlMs = 30 * 60 * 1000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  set(key: string, value: unknown, ttlMs?: number): void {
    this.prune();
    const now = Date.now();
    const expiresAt = now + (ttlMs ?? this.defaultTtlMs);
    this.cache.set(key, { value, expiresAt, updatedAt: now });
  }

  get(key: string): unknown | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
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
    const validEntries: Array<{ key: string; value: unknown; updatedAt: number }> = [];
    for (const [key, entry] of this.cache.entries()) {
      if (now <= entry.expiresAt) {
        validEntries.push({ key, value: entry.value, updatedAt: entry.updatedAt ?? 0 });
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

  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) this.cache.delete(key);
    }
  }

  size(): number {
    return this.cache.size;
  }
}
