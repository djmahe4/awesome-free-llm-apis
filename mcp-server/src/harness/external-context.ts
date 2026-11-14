import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decompress } from 'fzstd';
import { WorkspaceDirScanner, type ScannedDb } from './dir-scanner.js';

/**
 * External read-only context directories for coding agents (CodingAgentsInput.contextDirs).
 *
 * A module that reads another application's data (Zed's thread store, a log folder) is written against a data shape the
 * workspace alone does not show: the test fixture holds a hand-made slice, and a 7B model guesses the rest (`messages` as an
 * array instead of `{ messages: [...] }`). This scans the directories the CALLER names, with the same scanner the workspace
 * context uses, and reports STRUCTURE only: tables, columns and, for JSON or zstd-compressed JSON cells, the merged shape of
 * a few rows (keys and types). Values are never printed, so conversation text or other personal data cannot reach a prompt.
 * It reads local files only, opens databases read-only, and the pipeline keeps this block out of every cloud prompt.
 */

const MAX_DIRS = 3;
const SAMPLE_ROWS = 3;
const MAX_SHAPE_DEPTH = 12;
const MAX_KEYS = 14;
const SKIP = ['node_modules', '.git', 'logs', 'cache', 'extensions', 'languages', 'node', 'prettier', 'debug_adapters', 'hang_traces'];

type Json = unknown;

const kindOf = (v: Json): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** The merged structure of several JSON values: `{ messages: [ { User?: { content: [ { Text: string } ] } } ] }`. No values. */
export function jsonShape(values: Json[], depth = 0): string {
  const present = values.filter(v => v !== undefined);
  if (present.length === 0) return 'unknown';
  if (depth >= MAX_SHAPE_DEPTH) return '...';
  const kinds = [...new Set(present.map(kindOf))];
  const parts: string[] = [];
  const objects = present.filter(v => kindOf(v) === 'object') as Array<Record<string, Json>>;
  if (objects.length > 0) {
    const counts = new Map<string, number>();
    for (const o of objects) for (const k of Object.keys(o)) counts.set(k, (counts.get(k) ?? 0) + 1);
    // A map keyed by generated ids (tool-call ids, request uuids) is one shape, not N keys: `{ <id>: shape }`.
    const allKeys = [...counts.keys()];
    const idLike = (k: string) => k.length >= 10 && /\d/.test(k) && /^[\w-]+$/.test(k);
    if (allKeys.length >= 3 && allKeys.filter(idLike).length >= Math.ceil(allKeys.length * 0.8)) {
      parts.push(`{ <id>: ${jsonShape(objects.flatMap(o => Object.values(o)), depth + 1)} }`);
    }
    const keys = parts.length > 0 ? [] : allKeys.slice(0, MAX_KEYS);
    const body = keys.map(k => `${k}${counts.get(k)! < objects.length ? '?' : ''}: ${jsonShape(objects.map(o => o[k]), depth + 1)}`);
    const more = counts.size > keys.length && keys.length > 0 ? `, ...(+${counts.size - keys.length} keys)` : '';
    if (keys.length > 0) parts.push(`{ ${body.join(', ')}${more} }`);
  }
  const arrays = present.filter(v => kindOf(v) === 'array') as Json[][];
  if (arrays.length > 0) parts.push(`[ ${jsonShape(arrays.flatMap(a => a.slice(0, 12)), depth + 1)} ]`);
  for (const k of kinds) if (k !== 'object' && k !== 'array') parts.push(k);
  return [...new Set(parts)].join(' | ');
}

function cellToJson(value: unknown, dataType: unknown): Json | undefined {
  try {
    let text: string;
    if (value instanceof Uint8Array) {
      text = Buffer.from(dataType === 'zstd' ? decompress(value) : value).toString('utf8');
    } else if (typeof value === 'string') {
      text = value;
    } else {
      return undefined;
    }
    const t = text.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function describeDb(db: ScannedDb, label: string): string[] {
  const lines = [`${label}: SQLite`];
  let handle: DatabaseSync | undefined;
  try {
    handle = new DatabaseSync(db.path, { readOnly: true });
    for (const table of db.tables.slice(0, 8)) {
      lines.push(`  table ${table.name} (${table.rowCount} rows): ${table.columns.map(c => `${c.name} ${c.type}`).join(', ')}`);
      const quoted = `"${table.name.replace(/"/g, '""')}"`;
      let rows: Array<Record<string, unknown>> = [];
      try { rows = handle.prepare(`SELECT * FROM ${quoted} LIMIT ${SAMPLE_ROWS}`).all() as Array<Record<string, unknown>>; } catch { /* unreadable table: columns above still help */ }
      for (const column of table.columns) {
        const parsed = rows.map(r => cellToJson(r[column.name], r['data_type'])).filter(v => v !== undefined);
        if (parsed.length > 0) lines.push(`    ${table.name}.${column.name} holds JSON${rows.some(r => r['data_type'] === 'zstd' && r[column.name] instanceof Uint8Array) ? ' (zstd-compressed, decoded here)' : ''}: ${jsonShape(parsed)}`);
      }
    }
  } catch (err) {
    lines.push(`  (could not read: ${(err as Error)?.message ?? err})`);
  } finally {
    try { handle?.close(); } catch { /* read-only handle */ }
  }
  return lines;
}

export interface ExternalContextOptions { dirs: string[]; maxChars?: number }

/** One block describing the data in each readable directory (structure only), or '' when there is nothing to show. */
export function buildExternalContext(options: ExternalContextOptions): string {
  const blocks: string[] = [];
  for (const raw of options.dirs.slice(0, MAX_DIRS)) {
    let dir: string;
    try { dir = fs.realpathSync(path.resolve(raw)); if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    const label = path.basename(dir) || dir;
    const scan = new WorkspaceDirScanner(dir).scanDir({ maxDepth: 3, filesPerFolder: 40, skipDirs: SKIP, budgetMs: 2000, mapDbs: true });
    const lines: string[] = [`[External context (read-only, local, structure only, values omitted): ${label}]`];
    const dbs = scan.folders.flatMap(f => f.dbs ?? []);
    for (const db of dbs.slice(0, 4)) lines.push(...describeDb(db, path.relative(dir, db.path).replace(/\\/g, '/') || label));
    if (dbs.length === 0) {
      const names = scan.folders.slice(0, 6).map(f => `${path.relative(dir, f.path).replace(/\\/g, '/') || '.'}/: ${f.files.slice(0, 8).map(x => x.name).join(', ')}`);
      lines.push(...names);
    }
    blocks.push(lines.join('\n'));
  }
  const text = blocks.join('\n\n');
  const max = options.maxChars ?? 4500;
  return text.length > max ? `${text.slice(0, max)}\n[external context truncated]` : text;
}
