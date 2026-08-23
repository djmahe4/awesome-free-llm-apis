import path from 'path';
import os from 'os';
import { writeFileAtomic } from './FileUtils.js';
import fs from 'fs-extra';

const PROJECTS_DIR = path.join(os.homedir(), '.free-llm-mcp', 'projects');

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…[truncated]';
}

const FIVE_MB = 5 * 1024 * 1024;

/**
 * Intelligently extracts a concise, human-readable conversation title from the first tool output or response.
 * Strips markdown formatting, code blocks, conversational filler, and appends workspace unique ID or [none].
 */
export function extractIntelligentTitle(content: string, workspaceRoot?: string): string {
  if (!content || typeof content !== 'string') {
    const wsTag = workspaceRoot ? `[${path.basename(workspaceRoot.trim().replace(/[/\\]+$/, '')) || 'ws'}]` : '[none]';
    return `New Conversation ${wsTag}`;
  }

  let text = content.trim();

  // If content is JSON, parse and extract meaningful summary or field
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text);
      text = parsed.summary || parsed.title || parsed.description || parsed.goal || parsed.action || text;
    } catch {}
  }

  // 1. Check for markdown headings (# Heading or ## Heading)
  const headingMatch = text.match(/^#{1,3}\s+([^\n\r]+)/m);
  let rawTitle = '';
  if (headingMatch && headingMatch[1]) {
    rawTitle = headingMatch[1].trim();
  } else {
    // 2. Strip code blocks and markdown symbols
    const cleanText = text
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/[\*\_~#]/g, '')
      .trim();

    // 3. Remove common conversational filler sentences/clauses
    let stripped = cleanText
      .replace(/^(?:sure(?: thing)?|certainly|hello|hi|of course|okay|ok|great|got it|understood|i can help you with that|i can help|let me|here is|here are|i will)[\s!,.:;-]+/gi, '')
      .replace(/^(?:sure(?: thing)?|certainly|hello|hi|of course|okay|ok|great|got it|understood|i can help you with that|i can help|let me|here is|here are|i will)[\s!,.:;-]+/gi, '')
      .trim();

    // If still starting with generic greeting sentence (e.g. "I can help you with that."), take next sentence
    if (/^i (?:can|will) (?:help|assist|provide|do that|analyze)/i.test(stripped)) {
      const sentences = stripped.split(/[\n\.\?!]+/).map(s => s.trim()).filter(Boolean);
      if (sentences.length > 1) {
        stripped = sentences.slice(1).join('. ');
      }
    }

    // 4. Extract first 1-2 phrases / sentence (up to 45 chars or first sentence period/newline)
    const firstSentence = stripped.split(/[\n\.\?!]/)[0] || stripped;
    const words = firstSentence.trim().split(/\s+/).slice(0, 7);
    rawTitle = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  }

  // Clean punctuation and limit length
  rawTitle = rawTitle.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9\s\-_]+$/g, '').trim();
  if (rawTitle.length > 50) {
    rawTitle = rawTitle.slice(0, 47).trim() + '...';
  }
  if (!rawTitle) {
    rawTitle = 'Conversation';
  }

  // Compute workspace tag
  let wsTag = '[none]';
  if (workspaceRoot && typeof workspaceRoot === 'string') {
    const trimmedWs = workspaceRoot.trim().replace(/[/\\]+$/, '');
    if (trimmedWs && trimmedWs !== 'unknown') {
      const base = path.basename(trimmedWs);
      wsTag = `[${base || 'ws'}]`;
    }
  }

  return `${rawTitle} ${wsTag}`;
}

/**
 * Appends a turn to the workspace/session's chat-logs.json with 5MB rotation support.
 */
export async function logChatTurn(sessionId: string, turn: Record<string, any>): Promise<void> {
  try {
    const projectDir = path.join(PROJECTS_DIR, sessionId);
    const logPath = path.join(projectDir, 'chat-logs.json');
    await fs.ensureDir(projectDir);

    let log: any[] = [];
    try {
      const raw = await fs.readFile(logPath, 'utf-8');
      log = JSON.parse(raw);
    } catch { /* start fresh */ }

    const entryType = turn.role === 'tool_call' ? 'tool' : (turn.isError ? 'error' : 'chat');
    log.push({
      sessionId,
      timestamp: Date.now(),
      type: entryType,
      payload: turn
    });

    if (log.length > 200) log = log.slice(-200);

    const serialized = JSON.stringify(log, null, 2);
    if (serialized.length > FIVE_MB) {
      const rotatedPath = path.join(projectDir, 'chat-logs.1.json');
      try {
        await fs.move(logPath, rotatedPath, { overwrite: true });
      } catch {}
      log = log.slice(-50);
      await writeFileAtomic(logPath, JSON.stringify(log, null, 2));
    } else {
      await writeFileAtomic(logPath, serialized);
    }

    // Auto-generate title if name.txt doesn't exist yet and this is an assistant response
    if (turn.role === 'assistant' || turn.role === 'tool') {
      const nameFilePath = path.join(projectDir, 'name.txt');
      const nameExists = await fs.pathExists(nameFilePath);
      if (!nameExists) {
        const contentToTitle = turn.content || (typeof turn.result === 'string' ? turn.result : JSON.stringify(turn.result || '')) || '';
        if (contentToTitle) {
          const title = extractIntelligentTitle(contentToTitle, turn.workspaceRoot || turn.workspace_root);
          try {
            await fs.writeFile(nameFilePath, title, 'utf-8');
          } catch {}
        }
      }
    }
  } catch {
    // non-fatal — logging must never affect the call path
  }
}

/**
 * Logs a single tool invocation (role: 'tool_call') into the session log.
 * args/result are truncated to 400 chars each to avoid dumping base64 payloads.
 */
export async function logToolCall(
  sessionId: string,
  tool: string,
  args: unknown,
  result: unknown,
  latencyMs: number,
  isError = false
): Promise<void> {
  await logChatTurn(sessionId, {
    role: 'tool_call',
    tool,
    args: truncate(JSON.stringify(args ?? null), 400),
    result: truncate(JSON.stringify(result ?? null), 400),
    latencyMs,
    isError,
  });
}

