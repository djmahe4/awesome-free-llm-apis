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
  // 1. ResponseCache - Check for cached responses
  // 2. AgenticMiddleware - Handle agentic/reasoning mode if enabled
  // 3. IntelligentRouter - Select provider/model and execute (includes token management and LLM execution)
  // 
  // Note: TokenManager and LLMExecution are now handled internally by the Router
  // via LLMExecutor to support fallback retries without violating the middleware
  // single-call contract. The Router calls next() only once after provider selection.
  pipeline.use(sharedResponseCache);
  pipeline.use(agenticMiddleware);
  pipeline.use(sharedRouter);

  // Derive a foolproof sessionId if not explicitly provided
  let effectiveSessionId = inputSessionId;
  if (!effectiveSessionId && workspaceRoot) {
    try {
      const normalizedPath = path.resolve(workspaceRoot).replace(/\\/g, '/');
      const hash = crypto.createHash('sha256').update(normalizedPath).digest('hex').substring(0, 16);
      effectiveSessionId = `ws-${hash}`;
    } catch (err) {
      console.error('[useFreeLLM] Failed to derive foolproof sessionId from workspaceRoot:', err);
    }
  }

  const context: PipelineContext = {
    request,
    taskType: (input as any).taskType as TaskType || TaskType.Chat,
    workspaceRoot,
    wsHash: workspaceScanner.getWorkspaceHash(workspaceRoot),
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
