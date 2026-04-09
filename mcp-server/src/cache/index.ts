import { LRUCache } from 'lru-cache';
import { promises as fs, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { debounce } from '../utils/debounce.js';
import type { ChatRequest, ChatResponse } from '../providers/types.js';

export class ResponseCache {
  private cache: LRUCache<string, ChatResponse>;
  private persistPath: string | null = null;
  private debouncedPersist: (() => void) & { flush: () => void };

  private isLoaded = false;

  constructor(maxSize = 500, persistPath: string | null = null) {
    this.cache = new LRUCache<string, ChatResponse>({ max: maxSize });
    this.persistPath = persistPath;
    this.debouncedPersist = debounce(() => {
      this.persist().catch(err => console.error('Background persistence failed:', err));
    }, 2000);
  }

  async init(): Promise<void> {
    if (this.isLoaded || !this.persistPath) {
      this.isLoaded = true;
      return;
    }
    await this.load();
  }

  flush(): void {
    this.debouncedPersist.flush();
  }

  async set(key: string, value: ChatResponse): Promise<void> {
    if (!this.isLoaded) await this.init();
    this.cache.set(key, value);
    this.debouncedPersist();
  }

  async get(key: string): Promise<ChatResponse | undefined> {
    if (!this.isLoaded) await this.init();
    return this.cache.get(key);
  }

  generateKey(request: ChatRequest, workspaceHash: string): string {
    return JSON.stringify({
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      top_p: request.top_p,
      _ws: workspaceHash, // Workspace state hash
    });
  }

  private async persist(): Promise<void> {
    if (!this.persistPath) return;
    try {
      const data = JSON.stringify(Array.from(this.cache.entries()));
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.persistPath, data, 'utf-8');
    } catch (err) {
      console.error('Failed to persist cache:', err);
    }
  }

  private async load(): Promise<void> {
    if (!this.persistPath) return;
    try {
      if (existsSync(this.persistPath)) {
        const data = await fs.readFile(this.persistPath, 'utf8');
        const entries = JSON.parse(data) as Array<[string, ChatResponse]>;
        for (const [key, value] of entries) {
          this.cache.set(key, value);
        }
      }
      this.isLoaded = true;
    } catch (err) {
      console.error('Failed to load cache:', err);
      // Still mark as loaded to prevent repeated failed attempts
      this.isLoaded = true;
    }
  }

  clear(): void {
    this.cache.clear();
    this.debouncedPersist();
  }

  size(): number {
    return this.cache.size;
  }
}
