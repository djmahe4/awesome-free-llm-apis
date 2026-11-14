import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AntigravitySession {
  id: string;
  transcriptPath: string;
  title?: string;
  timeUpdated?: string;
}

export interface AntigravityThought {
  sessionId: string;
  messageId: string;
  timeCreated: string;
  text: string;
}

function normalizePath(p: string): string {
  return p.toLowerCase().replace(/\\/g, '/');
}

export function antigravityBrainRoot(homeDir = os.homedir()): string {
  const override = process.env['ANTIGRAVITY_DATA_DIR'];
  if (override) return override;
  return path.join(homeDir, '.gemini', 'antigravity', 'brain');
}

function stripUserRequestTag(text: string): string {
  const match = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  const inner = match ? match[1] : text;
  return inner.trim().replace(/\s+/g, ' ').slice(0, 120);
}

interface ParsedLine {
  type?: string;
  content?: string;
  created_at?: string;
  step_index?: unknown;
}

function parseTranscriptLine(line: string): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const type = typeof parsed['type'] === 'string' ? parsed['type'] : undefined;
    const content = typeof parsed['content'] === 'string' ? parsed['content'] : undefined;
    const createdAt = typeof parsed['created_at'] === 'string' ? parsed['created_at'] : undefined;
    return { type, content, created_at: createdAt, step_index: parsed['step_index'] };
  } catch {
    return null;
  }
}

function firstUserInputText(transcriptPath: string): string | undefined {
  let fd: number | null = null;
  try {
    const buffer = Buffer.alloc(64 * 1024);
    fd = fs.openSync(transcriptPath, 'r');
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const raw = buffer.toString('utf8', 0, bytesRead);
    for (const line of raw.split(/\r?\n/)) {
      const parsed = parseTranscriptLine(line);
      if (!parsed || parsed.type !== 'USER_INPUT' || !parsed.content) continue;
      return stripUserRequestTag(parsed.content);
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return undefined;
}

function mentionsWorkspace(transcriptPath: string, workspaceRoot: string): boolean {
  let fd: number | null = null;
  try {
    const buffer = Buffer.alloc(16 * 1024);
    fd = fs.openSync(transcriptPath, 'r');
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer.toString('utf8', 0, bytesRead);
    const collapse = (value: string) => normalizePath(value).replace(/\/+/g, '/');
    return collapse(head).includes(collapse(workspaceRoot));
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

export function listAntigravitySessions(
  homeDir = os.homedir(),
  workspaceRoot?: string,
): AntigravitySession[] {
  const root = antigravityBrainRoot(homeDir);
  if (!fs.existsSync(root)) return [];
  const sessions: AntigravitySession[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(dir, entry.name);
      if (entry.name === '.system_generated') {
        const logsDir = path.join(sub, 'logs');
        let logEntries: fs.Dirent[];
        try {
          logEntries = fs.readdirSync(logsDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const logEntry of logEntries) {
          if (!logEntry.isFile() || !logEntry.name.startsWith('transcript')) continue;
          const transcriptPath = path.join(logsDir, logEntry.name);
          if (workspaceRoot && !mentionsWorkspace(transcriptPath, workspaceRoot)) continue;
          let stat: fs.Stats | undefined;
          try {
            stat = fs.statSync(transcriptPath);
          } catch {
            continue;
          }
          sessions.push({
            id: path.basename(dir),
            transcriptPath,
            title: firstUserInputText(transcriptPath),
            timeUpdated: stat.mtime.toISOString(),
          });
        }
        continue;
      }
      walk(sub);
    }
  };
  walk(root);
  sessions.sort((a, b) => (b.timeUpdated ?? '').localeCompare(a.timeUpdated ?? ''));
  return sessions;
}

export function readAntigravityThoughts(
  transcriptPath: string,
  sessionId: string,
  limit = 20,
): AntigravityThought[] {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return [];
  }
  const thoughts: AntigravityThought[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseTranscriptLine(lines[i]);
    if (!parsed) continue;
    if (parsed.type !== 'PLANNER_RESPONSE') continue;
    if (!parsed.content) continue;
    const stepIndex = typeof parsed.step_index === 'number' ? parsed.step_index : i;
    thoughts.push({
      sessionId,
      messageId: `pr-${stepIndex}`,
      timeCreated: parsed.created_at ?? '',
      text: parsed.content,
    });
  }
  return thoughts.slice(-limit);
}
