import { DatabaseSync } from 'node:sqlite';
import { decompress } from 'fzstd';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceDirScanner, type ScannedDb } from './dir-scanner.js';
import { expandThoughtDag, type DagNode, type ThoughtDag } from './thought-dag.js';

export type ZedDagNode = DagNode;
export type ZedThoughtDag = ThoughtDag;

export interface ZedSession {
  id: string;
  title?: string;
  updatedAt?: string;
  folderPaths: string[];
}

interface ZedThreadRow {
  id: string;
  summary?: string;
  updated_at?: string;
  data_type?: string;
  data: Uint8Array | Buffer | string;
  folder_paths?: string | null;
}

const REQUIRED_THREAD_COLUMNS = ['id', 'summary', 'updated_at', 'data_type', 'data', 'folder_paths'];

export function zedThreadsDbPath(homeDir = os.homedir()): string {
  const direct = process.env.ZED_THREADS_DB;
  if (direct) return direct;
  const dataDir = process.env.ZED_DATA_DIR ?? process.env.LOCALAPPDATA ?? path.join(homeDir, 'AppData', 'Local');
  return path.join(dataDir, 'Zed', 'threads', 'threads.db');
}

export function scanZedThreadSchema(dbPath = zedThreadsDbPath()): ScannedDb | null {
  const dbDir = path.dirname(dbPath);
  const scan = new WorkspaceDirScanner(dbDir).scanDir({
    maxDepth: 0,
    filesPerFolder: 32,
    budgetMs: 5000,
    mapDbs: true,
  });
  const schema = scan.folders.flatMap(folder => folder.dbs ?? [])
    .find(db => path.resolve(db.path).toLowerCase() === path.resolve(dbPath).toLowerCase());
  if (!schema || schema.format !== 'sqlite') return null;
  const threads = schema.tables.find(table => table.name === 'threads');
  if (!threads) return null;
  const columns = new Set(threads.columns.map(column => column.name));
  return REQUIRED_THREAD_COLUMNS.every(column => columns.has(column)) ? schema : null;
}

export function openZedDb(dbPath = zedThreadsDbPath()): InstanceType<typeof DatabaseSync> | null {
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
}

function parseFolderPaths(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch { }
  return value.split(/[;\r\n]/).map(part => part.trim()).filter(Boolean);
}

export function listZedSessions(
  db: NonNullable<ReturnType<typeof openZedDb>>,
  workspaceRoot?: string,
): ZedSession[] {
  let rows: Array<Record<string, unknown>>;
  if (workspaceRoot) {
    const escapeSqlLike = (str: string) => str.replace(/([%_])/g, '\\$1');
    const needle = escapeSqlLike(workspaceRoot.toLowerCase().replace(/\\/g, '/'));
    rows = db.prepare(`
      SELECT id, summary, updated_at, folder_paths
      FROM threads
      WHERE LOWER(REPLACE(REPLACE(COALESCE(folder_paths, ''), char(92), '/'), '//', '/')) LIKE ? ESCAPE '\\'
      ORDER BY updated_at DESC
      LIMIT 500
    `).all(`%${needle}%`) as Array<Record<string, unknown>>;
  } else {
    rows = db.prepare(
      'SELECT id, summary, updated_at, folder_paths FROM threads ORDER BY updated_at DESC LIMIT 500',
    ).all() as Array<Record<string, unknown>>;
  }
  const workspace = workspaceRoot ? normalizePath(workspaceRoot) : undefined;
  return rows.map(row => ({
    id: String(row.id ?? ''),
    title: typeof row.summary === 'string' ? row.summary : undefined,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : undefined,
    folderPaths: parseFolderPaths(typeof row.folder_paths === 'string' ? row.folder_paths : undefined),
  })).filter(session => !workspace || session.folderPaths.some(folder => {
    const normalized = normalizePath(folder);
    return normalized === workspace || normalized.startsWith(`${workspace}/`);
  }));
}

function decodeThread(row: ZedThreadRow): Record<string, unknown> | null {
  try {
    const bytes = typeof row.data === 'string' ? Buffer.from(row.data, 'base64') : Buffer.from(row.data);
    if (bytes.length > 10_000_000) return null;
    const text = row.data_type === 'zstd' ? Buffer.from(decompress(bytes)).toString('utf8') : bytes.toString('utf8');
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringifyContext(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function messageText(message: Record<string, unknown>, role: string): string[] {
  const blocks: string[] = [];
  const content = Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const item = block as Record<string, unknown>;
    const text = item.Text;
    if (typeof text === 'string' && text.trim()) blocks.push(text);
    const thinking = item.Thinking;
    if (thinking && typeof thinking === 'object' && typeof (thinking as Record<string, unknown>).text === 'string') {
      const value = (thinking as Record<string, unknown>).text as string;
      if (value.trim()) blocks.push(value);
    }
    const mention = item.Mention;
    if (mention && typeof mention === 'object' && typeof (mention as Record<string, unknown>).content === 'string') {
      const value = (mention as Record<string, unknown>).content as string;
      if (value.trim()) blocks.push(value);
    }
    const toolUse = item.ToolUse;
    if (toolUse && typeof toolUse === 'object') {
      const call = toolUse as Record<string, unknown>;
      blocks.push(`Tool call: ${String(call.name ?? 'unknown')}\n${typeof call.raw_input === 'string' ? call.raw_input : stringifyContext(call.input)}`);
    }
  }
  const results = message.tool_results;
  if (results && typeof results === 'object') {
    for (const [callId, rawResult] of Object.entries(results as Record<string, unknown>)) {
      const result = rawResult && typeof rawResult === 'object' ? rawResult as Record<string, unknown> : {};
      const resultContent = Array.isArray(result.content)
        ? result.content.map(part => part && typeof part === 'object' && typeof (part as Record<string, unknown>).Text === 'string'
          ? (part as Record<string, unknown>).Text as string
          : stringifyContext(part)).join('\n')
        : stringifyContext(result.output ?? result.content ?? rawResult);
      if (resultContent.trim()) blocks.push(`Tool result (${callId})${result.is_error ? ' [error]' : ''}:\n${resultContent}`);
    }
  }
  if (blocks.length === 0 && role === 'User') return [];
  return blocks;
}

export function buildZedThoughtDag(sessionId: string, title: string, data: Record<string, unknown>): ZedThoughtDag {
  const nodes: DagNode[] = [];
  const byId = new Map<string, DagNode>();
  const toolCalls = new Map<string, string>();
  let tail: DagNode | null = null;
  let goal = '';
  let sequence = 0;

  const add = (kind: DagNode['kind'], text: string, timestamp?: string, parent = tail?.id ?? null): DagNode => {
    const id = `${sessionId}:${kind}:${++sequence}`;
    const node: DagNode = { id, parent, kind, text, depth: parent ? (byId.get(parent)?.depth ?? 0) + 1 : 0, timestamp };
    nodes.push(node);
    byId.set(id, node);
    tail = node;
    return node;
  };

  const messages = Array.isArray(data.messages) ? data.messages : [];
  for (const rawMessage of messages) {
    if (!rawMessage || typeof rawMessage !== 'object') continue;
    const entry = rawMessage as Record<string, unknown>;
    const role = Object.keys(entry).find(key => key === 'User' || key === 'Agent');
    if (!role) continue;
    const message = entry[role];
    if (!message || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    for (const block of Array.isArray(record.content) ? record.content : []) {
      if (!block || typeof block !== 'object') continue;
      const item = block as Record<string, unknown>;
      const use = item.ToolUse;
      if (use && typeof use === 'object') {
        const call = use as Record<string, unknown>;
        const node = add('tool_call', `Tool call: ${String(call.name ?? 'unknown')}\n${typeof call.raw_input === 'string' ? call.raw_input : stringifyContext(call.input)}`, typeof entry.timestamp === 'string' ? entry.timestamp : undefined);
        node.tool = typeof call.name === 'string' ? call.name : undefined;
        node.toolCallId = typeof call.id === 'string' ? call.id : undefined;
        node.input = typeof call.raw_input === 'string' ? call.raw_input : stringifyContext(call.input);
        if (node.toolCallId) toolCalls.set(node.toolCallId, node.id);
        continue;
      }
      const blockText = messageText({ content: [block] }, role);
      if (!blockText.length) continue;
      const text = `${role === 'User' ? 'User' : 'Assistant'}:\n${blockText.join('\n\n')}`;
      add(nodes.length === 0 ? 'root' : 'thought', text, typeof entry.timestamp === 'string' ? entry.timestamp : undefined);
      if (!goal && role === 'User') goal = blockText.join('\n\n');
    }
    const results = record.tool_results;
    if (results && typeof results === 'object') {
      for (const [callId, rawResult] of Object.entries(results as Record<string, unknown>)) {
        const result = rawResult && typeof rawResult === 'object' ? rawResult as Record<string, unknown> : {};
        const output = Array.isArray(result.content)
          ? result.content.map(part => part && typeof part === 'object' && typeof (part as Record<string, unknown>).Text === 'string'
            ? (part as Record<string, unknown>).Text as string
            : stringifyContext(part)).join('\n')
          : stringifyContext(result.output ?? result.content ?? rawResult);
        if (!output.trim()) continue;
        const parentId = toolCalls.get(callId) ?? (nodes.length ? nodes[nodes.length - 1].id : null);
        add('tool_result', output, typeof entry.timestamp === 'string' ? entry.timestamp : undefined, parentId).toolCallId = callId;
      }
    }
  }
  return { sessionId, goal: goal || title, nodes, byId };
}

export function expandZedThoughtDag(dag: ZedThoughtDag, query: string, maxChars = 24000): string {
  return expandThoughtDag(dag, query, maxChars);
}

export function readZedThoughtDags(
  workspaceRoot: string,
  options: { dbPath?: string; limit?: number } = {},
): ZedThoughtDag[] {
  const dbPath = options.dbPath ?? zedThreadsDbPath();
  if (!fs.existsSync(dbPath) || !scanZedThreadSchema(dbPath)) return [];
  const db = openZedDb(dbPath);
  if (!db) return [];
  try {
    const sessions = listZedSessions(db, workspaceRoot).slice(0, options.limit ?? 20);
    const getThread = db.prepare('SELECT data_type, data FROM threads WHERE id = ?');
    return sessions.flatMap(session => {
      const row = getThread.get(session.id) as { data_type?: string; data?: Uint8Array | Buffer | string } | undefined;
      if (!row || row.data === undefined) return [];
      const decoded = decodeThread({ ...row, data: row.data, id: session.id, summary: session.title, folder_paths: JSON.stringify(session.folderPaths) });
      return decoded ? [buildZedThoughtDag(session.id, session.title ?? '', decoded)] : [];
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}
