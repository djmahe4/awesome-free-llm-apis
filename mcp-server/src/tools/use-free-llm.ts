import { join } from 'node:path';
import { Router } from '../router/index.js';
import { ResponseCache } from '../cache/index.js';
import { WorkspaceScanner } from '../cache/workspace.js';
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
  workspace_root?: string;
}

const router = new Router();
const workspaceScanner = new WorkspaceScanner(process.cwd());
const cache = new ResponseCache(500, join(process.cwd(), 'data/cache.json'));
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
    workspace_root: workspaceRoot,
  } = input;

  const request: ChatRequest = {
    model,
    messages,
    temperature,
    max_tokens,
    top_p,
    stream,
  };

  const wsHash = workspaceScanner.getWorkspaceHash(workspaceRoot);
  const cacheKey = cache.generateKey(request, wsHash);
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
  await memoryManager.storeToolOutput('use_free_llm', { model, messages, _ws: wsHash }, response);

  return response;
}
