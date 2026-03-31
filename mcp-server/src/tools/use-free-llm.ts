import { WorkspaceScanner } from '../cache/workspace.js';
import type { ChatRequest, ChatResponse } from '../providers/types.js';
import {
  PipelineExecutor,
  ResponseCacheMiddleware,
  TokenManagerMiddleware,
  IntelligentRouterMiddleware,
  LLMExecutionMiddleware,
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
}

// Singleton instances for shared state across pipeline requests
const workspaceScanner = new WorkspaceScanner(process.cwd());
export const sharedTokenManager = new TokenManagerMiddleware();
const sharedResponseCache = new ResponseCacheMiddleware();
const sharedRouter = new IntelligentRouterMiddleware();
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

  pipeline.use(sharedResponseCache);
  pipeline.use(agenticMiddleware); // Enabled if input.agentic or env toggle is true
  pipeline.use(sharedRouter);
  pipeline.use(sharedTokenManager);
  pipeline.use(new LLMExecutionMiddleware());

  const context: PipelineContext = {
    request,
    taskType: (input as any).taskType as TaskType || TaskType.Chat,
    workspaceRoot,
    wsHash: workspaceScanner.getWorkspaceHash(workspaceRoot),
    providerId: providerId,
    agentic,
    sessionId: inputSessionId
  };

  const finalContext = await pipeline.execute(context);

  if (!finalContext.response) {
    throw new Error('Pipeline completed but no response was generated.');
  }

  return finalContext.response;
}

export function flushSystem(): void {
  sharedResponseCache.flush();
  sharedTokenManager.flush();
}
