import { Router } from '../router/index.js';
import { ResponseCache } from '../cache/index.js';
import { MemoryManager } from '../memory/index.js';
import type { ChatRequest, ChatResponse } from '../providers/types.js';

export interface UseFreeLLMInput {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  provider?: string;
  fallback?: boolean;
}

const router = new Router();
const cache = new ResponseCache();
const memoryManager = new MemoryManager();

export async function useFreeLLM(input: UseFreeLLMInput): Promise<ChatResponse> {
  const {
    model,
    messages,
    temperature = 0.7,
    max_tokens = 1024,
    top_p,
    stream = false,
    provider: providerId,
    fallback = true,
  } = input;

  const request: ChatRequest = {
    model,
    messages,
    temperature,
    max_tokens,
    top_p,
    stream,
  };

  const cacheKey = cache.generateKey(request);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let response: ChatResponse;

  if (fallback) {
    response = await router.routeWithFallback(model, request);
  } else {
    const p = router.route(model, providerId);
    response = await p.chat(request);
  }

  cache.set(cacheKey, response);
  await memoryManager.storeToolOutput('use_free_llm', { model, messages }, response);

  return response;
}
