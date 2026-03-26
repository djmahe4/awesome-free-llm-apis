import { LRUCache } from 'lru-cache';
import type { ChatRequest, ChatResponse } from '../providers/types.js';

export class ResponseCache {
  private cache: LRUCache<string, ChatResponse>;

  constructor(maxSize = 500) {
    this.cache = new LRUCache<string, ChatResponse>({ max: maxSize });
  }

  set(key: string, value: ChatResponse): void {
    this.cache.set(key, value);
  }

  get(key: string): ChatResponse | undefined {
    return this.cache.get(key);
  }

  generateKey(request: ChatRequest): string {
    return JSON.stringify({
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      top_p: request.top_p,
    });
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}
