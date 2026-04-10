import crypto from 'node:crypto';
import path from 'node:path';
import { WorkspaceScanner } from '../cache/workspace.js';
import type { ChatRequest, ChatResponse } from '../providers/types.js';
import {
  PipelineExecutor,
  ResponseCacheMiddleware,
  IntelligentRouterMiddleware,
  AgenticMiddleware,
  TaskType,
  type PipelineContext
} from '../pipeline/index.js';
import { StructuralMarkdownMiddleware } from '../middleware/agentic/structural-middleware.js';

export interface UseFreeLLMInput {
  model?: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  provider?: string;
  fallback?: boolean;
  workspace_root?: string;
  agentic?: boolean;
  sessionId?: string;
  taskType?: TaskType | string;
  keywords?: string[];
}

// Singleton instances for shared state across pipeline requests
const workspaceScanner = new WorkspaceScanner(process.cwd());
const sharedResponseCache = new ResponseCacheMiddleware();
export const sharedRouter = new IntelligentRouterMiddleware();
const agenticMiddleware = new AgenticMiddleware();
const structuralMarkdownMiddleware = new StructuralMarkdownMiddleware();

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
    agentic,
    sessionId: inputSessionId,
    workspace_root: workspaceRoot,
    keywords,
  } = input;

  const request: ChatRequest = {
    model,
    messages,
    temperature,
    max_tokens,
    top_p,
    stream,
    agentic,
  };

  const pipeline = new PipelineExecutor();

  // Pipeline order:
  // 1. StructuralMarkdownMiddleware - Inject full session memory into agentic requests (v1.0.4)
  // 2. ResponseCache - Check for cached responses
  // 3. AgenticMiddleware - Handle agentic/reasoning mode if enabled
  // 4. IntelligentRouter - Select provider/model and execute (includes token management and LLM execution)
  //
  // Note: TokenManager and LLMExecution are now handled internally by the Router
  // via LLMExecutor to support fallback retries without violating the middleware
  // single-call contract. The Router calls next() only once after provider selection.
  pipeline.use(structuralMarkdownMiddleware);
  pipeline.use(sharedResponseCache);
  pipeline.use(agenticMiddleware);
  pipeline.use(sharedRouter);

  const wsHash = workspaceScanner.getWorkspaceHash(workspaceRoot);

  // Derive a foolproof sessionId if not explicitly provided
  let effectiveSessionId = inputSessionId;
  if (!effectiveSessionId && (workspaceRoot || agentic)) {
    // v1.0.4 Hardening: Use the stable wsHash to derive sessionId if missing
    // This ensure agentic mode works even if workspace_root wasn't explicitly passed
    effectiveSessionId = `ws-${wsHash.substring(0, 16)}`;
  }

  const context: PipelineContext = {
    request,
    taskType: (input as any).taskType as TaskType || TaskType.Chat,
    workspaceRoot,
    wsHash,
    providerId: providerId,
    agentic,
    sessionId: effectiveSessionId,
    keywords
  };

  const finalContext = await pipeline.execute(context);

  if (!finalContext.response) {
    throw new Error('Pipeline completed but no response was generated.');
  }

  return finalContext.response;
}

export function flushSystem(): void {
  sharedResponseCache.flush();
  sharedRouter.flush();
}
