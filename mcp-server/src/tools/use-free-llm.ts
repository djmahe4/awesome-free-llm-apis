import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
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

/**
 * v1.0.4: Local TF-style summarization for large files (no API calls)
 */
export function summarizeTextLocally(text: string, limit: number): string {
  const sentences = text.split(/[.\n]/).filter(s => s.trim().length > 10);
  if (sentences.length < 5) return text.substring(0, limit) + "... [truncated]";

  const words = text.toLowerCase().match(/\w+/g) || [];
  const freq = new Map<string, number>();
  for (const w of words) {
    if (w.length > 3) freq.set(w, (freq.get(w) || 0) + 1);
  }

  const scored = sentences.map(s => {
    const sWords = s.toLowerCase().match(/\w+/g) || [];
    let score = 0;
    for (const sw of sWords) score += freq.get(sw) || 0;
    return { text: s.trim(), score: score / (sWords.length || 1) };
  });

  scored.sort((a, b) => b.score - a.score);

  let result = "<!-- summarized -->\n";
  let currentLen = result.length;
  // Keep original order if possible by filtering original sentences? 
  // No, just take top N.
  for (const s of scored) {
    if (currentLen + s.text.length + 2 > limit) break;
    result += s.text + ".\n";
    currentLen += s.text.length + 2;
  }
  return result;
}

/**
 * v1.0.4: Resolves file:// references in user messages.
 * Only allows files inside workspaceRoot or the Antigravity app data directory.
 */
export async function resolveFileRefs(content: string, workspaceRoot?: string): Promise<string> {
  // Regex matches [label](file://path) or bare file://path
  const fileUriRegex = /(?:\[([^\]]+)\]\()?file:\/\/([^\s)]+)(?:\))?/g;
  let newContent = content;
  const matches = [...content.matchAll(fileUriRegex)];
  
  const appDataRoot = path.join(os.homedir(), '.gemini', 'antigravity');
  const wsRoot = workspaceRoot ? path.resolve(workspaceRoot) : undefined;

  for (const match of matches) {
    const fullMatch = match[0];
    let uriPath = match[2];
    
    // Normalize path (handle Windows file:///C:/ style)
    let filePath = uriPath;
    if (filePath.startsWith('/')) {
        if (/^\/[A-Za-z]:\//.test(filePath)) {
            filePath = filePath.substring(1);
        }
    }
    filePath = path.normalize(decodeURIComponent(filePath));
    const absPath = path.resolve(filePath);

    // Security gate
    const isInsideWs = wsRoot && absPath.startsWith(wsRoot);
    const isInsideAppData = absPath.startsWith(appDataRoot);

    if (!isInsideWs && !isInsideAppData) {
        console.error(`[v1.0.4][resolveFileRefs] Security block: ${absPath} is outside allowed boundaries.`);
        continue;
    }

    try {
        if (await fs.pathExists(absPath) && (await fs.stat(absPath)).isFile()) {
            let fileData = await fs.readFile(absPath, 'utf-8');
            const MAX_CHARS = 12000;
            
            if (fileData.length > MAX_CHARS) {
                fileData = summarizeTextLocally(fileData, MAX_CHARS);
            }
            
            const baseName = path.basename(absPath);
            const replacement = `${fullMatch}\n\n\`\`\`file:${baseName}\n${fileData}\n\`\`\``;
            newContent = newContent.replace(fullMatch, replacement);
            console.error(`[v1.0.4][resolveFileRefs] Inlined ${baseName} (${fileData.length} chars)`);
        }
    } catch (err) {
        console.error(`[v1.0.4][resolveFileRefs] Failed to read ${absPath}:`, err);
    }
  }
  return newContent;
}

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

  // v1.0.4 Resolution Pass: Resolve file:// references in user messages
  if (agentic) {
    for (const msg of messages) {
      if (msg.role === 'user' && typeof msg.content === 'string') {
        msg.content = await resolveFileRefs(msg.content, workspaceRoot);
      }
    }
  }

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
  pipeline.use(structuralMarkdownMiddleware);
  pipeline.use(sharedResponseCache);
  pipeline.use(agenticMiddleware);
  pipeline.use(sharedRouter);

  const wsHash = workspaceScanner.getWorkspaceHash(workspaceRoot);

  // Derive a foolproof sessionId if not explicitly provided
  let effectiveSessionId = inputSessionId;
  if (!effectiveSessionId && (workspaceRoot || agentic)) {
    // v1.0.4 Hardening: Use the stable wsHash to derive sessionId if missing
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
