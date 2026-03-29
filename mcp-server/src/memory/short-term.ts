interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

export class ShortTermMemory {
  private cache: Map<string, CacheEntry> = new Map();
  private defaultTtlMs: number;

  constructor(defaultTtlMs = 30 * 60 * 1000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  set(key: string, value: unknown, ttlMs?: number): void {
    this.prune();
    const expiresAt = Date.now() + (ttlMs ?? this.defaultTtlMs);
    this.cache.set(key, { value, expiresAt });
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
