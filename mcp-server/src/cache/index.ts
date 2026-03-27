import { LRUCache } from 'lru-cache';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChatRequest, ChatResponse } from '../providers/types.js';

export class ResponseCache {
  private cache: LRUCache<string, ChatResponse>;
  private persistPath: string | null = null;

  constructor(maxSize = 500, persistPath: string | null = null) {
    this.cache = new LRUCache<string, ChatResponse>({ max: maxSize });
    this.persistPath = persistPath;
    this.loadFromDisk();
  }

  set(key: string, value: ChatResponse): void {
    this.cache.set(key, value);
    this.persist();
  }

  get(key: string): ChatResponse | undefined {
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

  private persist(): void {
    if (!this.persistPath) return;
    try {
      const data = JSON.stringify(Array.from(this.cache.entries()));
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.persistPath, data);
    } catch (err) {
      console.error('Failed to persist cache:', err);
    }
  }

  private loadFromDisk(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const data = readFileSync(this.persistPath, 'utf8');
      const entries = JSON.parse(data) as Array<[string, ChatResponse]>;
      for (const [key, value] of entries) {
        this.cache.set(key, value);
      }
    } catch (err) {
      console.error('Failed to load cache:', err);
    }
  }

  clear(): void {
    this.cache.clear();
    this.persist();
  }

  size(): number {
    return this.cache.size;
  }
}
