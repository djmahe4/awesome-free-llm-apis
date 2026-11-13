import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';

export interface OpencodeSession {
  id: string;
  directory?: string;
  title?: string;
  timeUpdated?: string;
}

export interface OpencodeThought {
  sessionId: string;
  messageId: string;
  timeCreated: string;
  text: string;
}

export function opencodeDbPath(homeDir: string = process.env.OPENCODE_DATA_DIR ?? os.homedir()): string {
  if (process.env.OPENCODE_DATA_DIR) return process.env.OPENCODE_DATA_DIR;
    const sep = homeDir.includes('\\') ? '\\' : '/';
  return `${homeDir}${sep}.local${sep}share${sep}opencode${sep}opencode.db`;
}

type SqliteDb = InstanceType<typeof DatabaseSync>;

export function openOpencodeDb(dbPath: string): SqliteDb | null {
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

export function listOpencodeSessions(db: NonNullable<ReturnType<typeof openOpencodeDb>>, directoryFilter?: string): OpencodeSession[] {
  const rows = db.prepare('SELECT id, directory, title, time_updated FROM session ORDER BY time_updated DESC LIMIT 200').all() as Array<Record<string, unknown>>;
  const sessions = rows.map(r => ({
    id: String(r.id ?? ''),
    directory: r.directory != null ? String(r.directory) : undefined,
    title: r.title != null ? String(r.title) : undefined,
    timeUpdated: r.time_updated != null ? String(r.time_updated) : undefined,
  }));
  if (!directoryFilter) return sessions;
  const needle = directoryFilter.toLowerCase().replace(/\\/g, '/');
  return sessions.filter(s => (s.directory ?? '').toLowerCase().replace(/\\/g, '/').includes(needle));
}

export function readOpencodeThoughts(
  db: NonNullable<ReturnType<typeof openOpencodeDb>>,
  sessionId: string,
  limit = 20,
): OpencodeThought[] {
  const messages = db
    .prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC')
    .all(sessionId) as Array<{ id: string; data: string }>;
  const thoughts: OpencodeThought[] = [];
  for (const msg of messages) {
    let role = '';
    try {
      role = String(JSON.parse(msg.data)?.role ?? '');
    } catch { continue; }
    if (role !== 'assistant') continue;
    const parts = db
      .prepare('SELECT id, data, time_created FROM part WHERE message_id = ? ORDER BY time_created ASC')
      .all(msg.id) as Array<{ id: string; data: string; time_created: string }>;
    for (const part of parts) {
      try {
        const parsed = JSON.parse(part.data) as { type?: string; text?: unknown };
        if (parsed.type !== 'reasoning' || typeof parsed.text !== 'string' || !parsed.text.trim()) continue;
        thoughts.push({ sessionId, messageId: msg.id, timeCreated: String(part.time_created ?? ''), text: parsed.text });
      } catch { }
    }
  }
  return thoughts.slice(-limit);
}
