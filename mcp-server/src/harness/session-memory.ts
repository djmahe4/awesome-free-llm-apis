import { promises as fs } from 'fs';
import path from 'path';
import { withFileLock } from '../utils/file-lock.js';

export interface SessionMemoryEntry {
  ts: number;
  runId: string;
  role: string;
  type: 'finding' | 'hypothesis';
  text: string;
}

export const SESSION_MEMORY_INJECT_COUNT = 5;
export const SESSION_MEMORY_MAX_TEXT_CHARS = 2000;

export function sessionMemoryPath(runDir: string): string {
  return path.join(runDir, 'session-memory.jsonl');
}

function isSessionMemoryEntry(value: any): value is SessionMemoryEntry {
  return !!value && typeof value === 'object'
    && typeof value.ts === 'number'
    && typeof value.runId === 'string'
    && typeof value.role === 'string'
    && typeof value.text === 'string'
    && (value.type === 'finding' || value.type === 'hypothesis');
}

export async function readSessionMemory(runDir: string): Promise<SessionMemoryEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(sessionMemoryPath(runDir), 'utf-8');
  } catch {
    return [];
  }
  const entries: SessionMemoryEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isSessionMemoryEntry(parsed)) entries.push(parsed);
    } catch {
      continue;
    }
  }
  return entries;
}

export async function recentSessionMemory(runDir: string, count: number = SESSION_MEMORY_INJECT_COUNT): Promise<SessionMemoryEntry[]> {
  const all = await readSessionMemory(runDir);
  return all.slice(-count);
}

export async function appendSessionMemory(runDir: string, entry: Omit<SessionMemoryEntry, 'ts'> & { ts?: number }): Promise<SessionMemoryEntry> {
  const full: SessionMemoryEntry = { ts: entry.ts ?? Date.now(), runId: entry.runId, role: entry.role, type: entry.type, text: entry.text };
  await fs.mkdir(runDir, { recursive: true });
  const filePath = sessionMemoryPath(runDir);
  const line = JSON.stringify(full) + '\n';
  await withFileLock(filePath, async () => {
    await fs.appendFile(filePath, line, 'utf-8');
  });
  return full;
}

export function parseTurnMemory(output: string): { type: SessionMemoryEntry['type']; text: string } | null {
  const trimmed = (output ?? '').trim();
  if (!trimmed) return null;
  const text = trimmed.slice(0, SESSION_MEMORY_MAX_TEXT_CHARS);
  const type: SessionMemoryEntry['type'] = /\bhypothes/i.test(text) ? 'hypothesis' : 'finding';
  return { type, text };
}

function sanitizePromptValue(value: string): string {
  return value
    .replace(/[<>]/g, ch => (ch === '<' ? '&lt;' : '&gt;'))
    .replace(/[`[\]]/g, '') // strip delimiters that could escape entry or block formatting
    .replace(/\b(system|assistant|user):/gi, '$1_') // neutralize simulated role headers
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildSessionMemoryPromptBlock(entries: SessionMemoryEntry[]): string {
  if (entries.length === 0) return '';
  const lines = entries.map(e =>
    `- [${sanitizePromptValue(e.type)}] (${sanitizePromptValue(e.role)}) ${sanitizePromptValue(e.text)}`);
  return `<session-memory>\n${lines.join('\n')}\n</session-memory>`;
}
