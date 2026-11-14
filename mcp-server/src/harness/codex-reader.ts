import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { isSameOrNestedWorkspacePath } from './workspace-path.js';

export interface CodexSession {
  id: string;
  rolloutPath: string;
  cwd?: string;
  title?: string;
  timeUpdated?: string;
}

export interface CodexThought {
  sessionId: string;
  messageId: string;
  timeCreated: string;
  text: string;
}

export function codexHome(homeDir: string = os.homedir()): string {
  return process.env.CODEX_HOME ?? path.join(homeDir, '.codex');
}

export function codexSessionsRoot(homeDir: string = os.homedir()): string {
  return path.join(codexHome(homeDir), 'sessions');
}

export function normalizeCodexPath(p: string): string {
  return p.toLowerCase().replace(/\\/g, '/');
}

function readFirstLine(filePath: string, maxBytes = 1024 * 1024): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    let text = '';
    let pos = 0;
    while (text.length < maxBytes) {
      const buf = Buffer.alloc(64 * 1024);
      const read = fs.readSync(fd, buf, 0, buf.length, pos);
      if (read === 0) break;
      pos += read;
      const chunk = buf.subarray(0, read).toString('utf8');
      const nl = chunk.indexOf('\n');
      if (nl !== -1) return text + chunk.slice(0, nl);
      text += chunk;
    }
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { }
    }
  }
}

function parseFirstLineJson(line: string): { id?: string; cwd?: string } | null {
  try {
    const j = JSON.parse(line) as { type?: unknown; payload?: { id?: unknown; session_id?: unknown; cwd?: unknown } };
    if (j.type !== 'session_meta' || !j.payload) return null;
    const id = typeof j.payload.id === 'string' ? j.payload.id : typeof j.payload.session_id === 'string' ? j.payload.session_id : undefined;
    const cwd = typeof j.payload.cwd === 'string' ? j.payload.cwd : undefined;
    if (!id) return null;
    return { id, cwd };
  } catch {
    const idMatch = line.match(/"(?:id|session_id)"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i);
    if (!idMatch) return null;
    const cwdMatch = line.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    let cwd: string | undefined;
    if (cwdMatch) {
      try { cwd = JSON.parse(`"${cwdMatch[1]}"`) as string; } catch { cwd = cwdMatch[1]; }
    }
    return { id: idMatch[1], cwd };
  }
}

interface CodexTitleIndexEntry { title?: string; timeUpdated?: string }

export function codexTitleIndex(homeDir: string = os.homedir()): Map<string, CodexTitleIndexEntry> {
  const indexFile = path.join(codexHome(homeDir), 'session_index.jsonl');
  const out = new Map<string, CodexTitleIndexEntry>();
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(indexFile, 'utf8').split('\n');
  } catch {
    return out;
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as { id?: unknown; thread_name?: unknown; updated_at?: unknown };
      if (typeof j.id === 'string') {
        out.set(j.id, {
          title: typeof j.thread_name === 'string' ? j.thread_name : undefined,
          timeUpdated: typeof j.updated_at === 'string' ? j.updated_at : undefined,
        });
      }
    } catch { }
  }
  return out;
}

export function listCodexSessions(homeDir: string, directoryFilter?: string): CodexSession[] {
  const root = codexSessionsRoot(homeDir);
  let entries: fs.Dirent[];
  try {
    if (!fs.existsSync(root)) return [];
    entries = fs.readdirSync(root, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  const titles = codexTitleIndex(homeDir);
  const needle = directoryFilter ? normalizeCodexPath(directoryFilter) : null;
  const found: Array<{ s: CodexSession; mtime: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue;
    const fullPath = path.join(entry.parentPath ?? entry.path ?? root, entry.name);
    const meta = parseFirstLineJson(readFirstLine(fullPath));
    if (!meta) continue;
    const id = meta.id;
    const cwd = meta.cwd;
    if (!id) continue;
    if (needle && (!cwd || !isSameOrNestedWorkspacePath(cwd, directoryFilter!))) continue;
    let mtime = 0;
    try { mtime = fs.statSync(fullPath).mtimeMs; } catch { }
    const idx = titles.get(id);
    found.push({
      s: {
        id,
        rolloutPath: fullPath,
        cwd,
        title: idx?.title,
        timeUpdated: idx?.timeUpdated,
      },
      mtime,
    });
  }
  return found.sort((a, b) => b.mtime - a.mtime).map(e => e.s);
}

interface CodexLinePayload {
  type?: unknown;
  id?: unknown;
  role?: unknown;
  message?: unknown;
  timestamp?: unknown;
  content?: unknown;
}

export async function readCodexThoughts(rolloutPath: string, sessionId: string, limit = 20): Promise<CodexThought[]> {
  if (!fs.existsSync(rolloutPath)) return [];
  return new Promise(resolve => {
    const primary: CodexThought[] = [];
    const fallback: CodexThought[] = [];
    const rl = createInterface({ input: createReadStream(rolloutPath, { encoding: 'utf8' }), crlfDelay: Infinity });
    let lineNo = 0;
    rl.on('line', line => {
      lineNo++;
      if (!line.trim()) return;
      let j: { type?: unknown; payload?: CodexLinePayload; timestamp?: unknown };
      try {
        j = JSON.parse(line) as typeof j;
      } catch {
        return;
      }
      const payload = j.payload;
      if (!payload) return;
      const ts = typeof payload.timestamp === 'string' ? payload.timestamp : typeof j.timestamp === 'string' ? j.timestamp : '';
      if (j.type === 'response_item' && payload.role === 'assistant' && Array.isArray(payload.content)) {
        for (const part of payload.content as Array<{ type?: unknown; text?: unknown }>) {
          if (part?.type === 'output_text' && typeof part.text === 'string' && part.text.trim()) {
            primary.push({
              sessionId,
              messageId: typeof payload.id === 'string' ? payload.id : `msg-${lineNo}`,
              timeCreated: ts,
              text: part.text,
            });
          }
        }
      } else if (j.type === 'event_msg' && payload.type === 'agent_message' && typeof payload.message === 'string' && payload.message.trim()) {
        fallback.push({
          sessionId,
          messageId: `agent-${lineNo}`,
          timeCreated: ts,
          text: payload.message,
        });
      }
    });
    rl.on('close', () => {
      const thoughts = primary.length ? primary : fallback;
      resolve(thoughts.slice(-limit));
    });
    rl.on('error', () => resolve(primary.slice(-limit)));
  });
}
