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
 * v1.0.4: Platform-aware artifact roots for model-specific context.
 */
const artifactRoots = {
  claude: process.env.CLAUDE_ARTIFACTS_DIR || path.join(os.homedir(), '.anthropic', 'artifacts'),
  chatgpt: process.env.CHATGPT_ARTIFACTS_DIR || path.join(os.homedir(), '.openai', 'artifacts'),
  codex: process.env.CODEX_ARTIFACTS_DIR || path.join(os.homedir(), '.codex', 'artifacts'),
  antigravity: process.env.ANTIGRAVITY_APP_DATA || path.join(os.homedir(), '.gemini', 'antigravity')
};

/**
 * v1.0.4: Scans the last 2 messages for code blocks matching a filename.
 * fufills the "user provided context via markdown" fallback.
 */
async function findInRecentMessages(filename: string, messages: any[]): Promise<string | null> {
  const recent = messages.slice(-3, -1);
  for (const msg of recent) {
    if (typeof msg.content !== 'string') continue;
    const codeBlockRegex = new RegExp(`\`\`\`(?:file:)?${filename}\\n([\\s\\S]*?)\`\`\``, 'i');
    const match = codeBlockRegex.exec(msg.content);
    if (match) return match[1];
  }
  return null;
}

/**
 * v1.0.4: Resolves file://, artifact://, ctx7://, and mcp:// references in user messages.
 */
export async function resolveFileRefs(content: string, messages: any[], workspaceRoot?: string): Promise<string> {
  const uriRegex = /(?:\[([^\]]+)\]\()?(file|mcp|ctx7|artifact):\/\/([^\s)]+)(?:\))?/gi;
  let newContent = content;
  const matches = [...content.matchAll(uriRegex)];

  const wsRoot = (workspaceRoot && workspaceRoot.trim()) ? path.resolve(workspaceRoot) : undefined;

  for (const match of matches) {
    const fullMatch = match[0];
    const protocol = match[2].toLowerCase();
    const uriPath = match[3];
    let resolvedContent: string | null = null;
    let sourceLabel = '';

    if (protocol === 'file' || protocol === 'artifact') {
      let filePath = uriPath;
      if (protocol === 'artifact') {
        const platform = uriPath.split('/')[0].toLowerCase();
        const relativePath = uriPath.split('/').slice(1).join('/');
        const root = (artifactRoots as any)[platform] || artifactRoots.antigravity;
        filePath = path.join(root, relativePath);
        sourceLabel = `artifact:${platform}`;
      } else {
        if (filePath.startsWith('/')) {
          if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.substring(1);
        }
        sourceLabel = 'file';
      }

      filePath = path.normalize(decodeURIComponent(filePath));
      const absPath = path.resolve(filePath);
      const normAbs = absPath.replace(/\\/g, '/');

      const allowedRoots = [
        wsRoot,
        artifactRoots.claude,
        artifactRoots.chatgpt,
        artifactRoots.codex,
        artifactRoots.antigravity
      ].filter(Boolean).map(r => r!.replace(/\\/g, '/'));

      const isAuthorized = allowedRoots.some(root => {
        if (process.platform === 'win32' && /^[A-Za-z]:\//.test(normAbs)) {
          return normAbs.toLowerCase().startsWith(root.toLowerCase());
        }
        return normAbs.startsWith(root);
      });

      if (!isAuthorized) {
        console.error(`[v1.0.4][resolveRefs] Security block: ${absPath} is outside allowed boundaries`);
        continue;
      }

      try {
        if (await fs.pathExists(absPath) && (await fs.stat(absPath)).isFile()) {
          resolvedContent = await fs.readFile(absPath, 'utf-8');
        }
      } catch (err) {
        console.error(`[v1.0.4][resolveRefs] Disk read failed for ${absPath}:`, err);
      }

      if (!resolvedContent) {
        const fileName = path.basename(absPath);
        resolvedContent = await findInRecentMessages(fileName, messages);
        if (resolvedContent) sourceLabel += ':history';
      }

      if (resolvedContent) {
        const MAX_CHARS = 12000;
        if (resolvedContent.length > MAX_CHARS) {
          resolvedContent = summarizeTextLocally(resolvedContent, MAX_CHARS);
        }
        const baseName = path.basename(absPath);
        const replacement = `${fullMatch}\n\n\`\`\`${sourceLabel}:${baseName}\n${resolvedContent}\n\`\`\``;
        newContent = newContent.replace(fullMatch, replacement);
        console.error(`[v1.0.4][resolveRefs] Resolved ${baseName} via ${sourceLabel}`);
      }
    } else if (protocol === 'ctx7') {
      /**
       * v1.0.4 Placeholder: Context7 Integration
       * FUTURE(TODO): Implement resolver using context7 MCP server.
       * CONSTRAINT: Cap total tool calls to 3 per query.
       */
      console.warn(`[v1.0.4][resolveRefs] ctx7 protocol not yet implemented: ${uriPath}`);
    } else if (protocol === 'mcp') {
      console.warn(`[v1.0.4][resolveRefs] mcp protocol not yet implemented: ${uriPath}`);
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

  // v1.0.4 Resolution Pass: Resolve file, artifact, ctx7 references in user messages
  if (agentic) {
    for (const msg of messages) {
      if (msg.role === 'user' && typeof msg.content === 'string') {
        msg.content = await resolveFileRefs(msg.content, messages, workspaceRoot);
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

  const wsHash = await workspaceScanner.getWorkspaceHash(workspaceRoot);

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
