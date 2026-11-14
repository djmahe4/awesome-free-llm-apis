import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { Sanitizer } from '../utils/Sanitizer.js';

export type PiiClass = 'person' | 'secret' | 'email' | 'phone' | null;

export function classifyColumn(name: string): PiiClass {
  const n = name.toLowerCase();
  if (/(?:^|_)(?:key|token|secret|password|passwd|pwd|auth|credential|salt|hash|private)(?:$|_)/.test(n)) return 'secret';
  if (/(?:^|_)(?:email|e_mail|e-mail)(?:$|_)/.test(n)) return 'email';
  if (/(?:^|_)(?:phone|mobile|tel|telephone)(?:$|_)/.test(n)) return 'phone';
  if (/(?:^|_)(?:name|author|owner|user|person|creator)(?:$|_)/.test(n) && !/(?:^|_)(?:file|path|dir|table|column|host|domain|db|schema|nick)/.test(n)) return 'person';
  return null;
}

const NON_NAME_WORDS = new Set([
  'the', 'this', 'that', 'and', 'but', 'for', 'you', 'your', 'with', 'from', 'have', 'has', 'had',
  'are', 'was', 'were', 'been', 'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must',
  'not', 'all', 'any', 'new', 'use', 'used', 'using', 'node', 'zed', 'test', 'file', 'files',
  'code', 'line', 'lines', 'error', 'errors', 'llm', 'api', 'mcp', 'http', 'https', 'read',
  'write', 'made', 'set', 'get', 'let', 'its', 'his', 'her', 'one', 'two', 'run', 'end', 'sum',
  'md', 'ts', 'js', 'json', 'sql', 'db', 'sqlite', 'claude', 'codex', 'gemini', 'openai',
  'anthropic', 'google', 'vercel', 'github', 'there', 'then', 'when', 'what', 'which', 'while',
  'after', 'before', 'next', 'first', 'last', 'now', 'here', 'they', 'them', 'their', 'our',
  'out', 'off', 'per', 'via', 'into', 'over', 'under', 'also', 'just', 'like', 'only', 'than',
  'some', 'most', 'more', 'less', 'none', 'both', 'each', 'same', 'such', 'much', 'many', 'well',
]);

const TITLE_CASE_BIGRAM = /\b([A-Z][a-z]{2,})\s+([A-Z][a-z]{2,})\b/g;

export interface PersonPseudonymizer {
  aliasValue(value: string): string;
  pseudonymize(text: string): string;
  knownCount(): number;
}

export function createPersonPseudonymizer(): PersonPseudonymizer {
  const aliases = new Map<string, string>();
  const aliasFor = (canonical: string): string => {
    const existing = aliases.get(canonical);
    if (existing) return existing;
    const alias = `person${aliases.size + 1}`;
    aliases.set(canonical, alias);
    return alias;
  };

  return {
    aliasValue(value: string): string {
      const trimmed = value.trim().replace(/\s+/g, ' ');
      if (trimmed.length < 3) return value;
      if (/[@/:\\\d]/.test(trimmed)) return value;
      const words = trimmed.split(' ');
      const nameLike = words.length >= 2 && words.every(w => /^[A-Z][a-z]{2,}$/.test(w) && !NON_NAME_WORDS.has(w.toLowerCase()));
      if (!nameLike) return value;
      const canonical = trimmed.toLowerCase();
      return aliasFor(canonical);
    },
    pseudonymize(text: string): string {
      let out = Sanitizer.sanitize(text);
      for (const [canonical, alias] of aliases) {
        out = out.replace(new RegExp(`\\b${canonical.replace(/\s+/g, '\\s+')}\\b`, 'gi'), alias);
      }
      out = out.replace(TITLE_CASE_BIGRAM, (match, a: string, b: string) => {
        if (NON_NAME_WORDS.has(a.toLowerCase()) || NON_NAME_WORDS.has(b.toLowerCase())) return match;
        return `${aliasFor(`${a} ${b}`.toLowerCase())}`;
      });
      return out;
    },
    knownCount(): number {
      return aliases.size;
    },
  };
}

export function sanitizeText(text: string, pseudonymizer?: PersonPseudonymizer): string {
  const base = Sanitizer.sanitize(text);
  return pseudonymizer ? pseudonymizer.pseudonymize(base) : base;
}

export interface ScannedFile {
  name: string;
  size: number;
  mtimeMs: number;
}

export interface DbColumn {
  name: string;
  type: string;
  pii: PiiClass;
}

export interface DbTable {
  name: string;
  rowCount: number;
  columns: DbColumn[];
}

export interface ScannedDb {
  path: string;
  format: 'sqlite';
  tables: DbTable[];
}

export interface ScannedFolder {
  path: string;
  depth: number;
  files: ScannedFile[];
  subdirs: number;
  dbs?: ScannedDb[];
}

export interface DirScanResult {
  root: string;
  folders: ScannedFolder[];
  truncated: boolean;
  elapsedMs: number;
}

export interface ScanDirOptions {
  maxDepth?: number;
  filesPerFolder?: number;
  skipDirs?: string[];
  budgetMs?: number;
  mapDbs?: boolean;
}

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');
const DEFAULT_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'cache', '.free-llm-mcp', '.mcp-uploads', 'checkpoints', 'tmp-context-smoke', 'tmp', 'temp', 'scratch'
]);

export class WorkspaceDirScanner {
  constructor(private readonly workspaceRoot: string) { }

  scanDir(options: ScanDirOptions = {}): DirScanResult {
    const startedAt = Date.now();
    const maxDepth = options.maxDepth ?? 4;
    const filesPerFolder = options.filesPerFolder ?? 5;
    const mapDbs = options.mapDbs !== false;
    const budgetMs = options.budgetMs ?? 2000;
    const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...(options.skipDirs ?? [])]);
    const folders: ScannedFolder[] = [];
    let truncated = false;

    const queue: Array<{ dir: string; depth: number }> = [{ dir: this.workspaceRoot, depth: 0 }];
    while (queue.length > 0) {
      if (Date.now() - startedAt > budgetMs) {
        truncated = true;
        break;
      }
      const { dir, depth } = queue.shift()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));

      const files: ScannedFile[] = [];
      const subdirs: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (depth >= maxDepth) {
            truncated = true;
          } else if (!skipDirs.has(entry.name.toLowerCase())) {
            subdirs.push(entry.name);
          }
          continue;
        }
        if (!entry.isFile()) continue;
        if (files.length >= filesPerFolder) {
          truncated = true;
          continue;
        }
        try {
          const stat = fs.statSync(path.join(dir, entry.name));
          files.push({ name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch { }
      }

      const folder: ScannedFolder = { path: dir, depth, files, subdirs: subdirs.length };
      if (mapDbs) {
        const dbs: ScannedDb[] = [];
        for (const file of files) {
          if (!/\.(?:db|sqlite|sqlite3)$/i.test(file.name)) continue;
          const dbPath = path.join(dir, file.name);
          if (isSqliteFile(dbPath)) {
            const mapped = mapSqliteSchema(dbPath);
            if (mapped !== null) dbs.push(mapped);
          }
        }
        if (dbs.length > 0) folder.dbs = dbs;
      }
      folders.push(folder);

      for (const name of subdirs) {
        queue.push({ dir: path.join(dir, name), depth: depth + 1 });
      }
    }

    return { root: this.workspaceRoot, folders, truncated, elapsedMs: Date.now() - startedAt };
  }
}

export interface DirScanArgs {
  workspace_root: string;
  max_depth?: number;
  files_per_folder?: number;
  skip_dirs?: string[];
  budget_ms?: number;
  map_dbs?: boolean;
}

export async function scanWorkspace(args: DirScanArgs): Promise<DirScanResult> {
  const { workspace_root, max_depth, files_per_folder, skip_dirs, budget_ms, map_dbs } = args;
  const scanner = new WorkspaceDirScanner(workspace_root);
  return scanner.scanDir({
    maxDepth: max_depth,
    filesPerFolder: files_per_folder,
    skipDirs: skip_dirs,
    budgetMs: budget_ms,
    mapDbs: map_dbs,
  });
}

function isSqliteFile(filePath: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    const read = fs.readSync(fd, buf, 0, 16, 0);
    if (read < 16) return false;
    return buf.equals(SQLITE_MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { }
    }
  }
}

function mapSqliteSchema(dbPath: string): ScannedDb | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const mapped: DbTable[] = [];
    for (const { name } of tables) {
      try {
        const quoted = `"${name.replace(/"/g, '""')}"`;
        const countRow = db.prepare(`SELECT COUNT(*) AS c FROM ${quoted}`).get() as { c: number };
        const cols = db.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{ name: string; type: string }>;
        mapped.push({
          name,
          rowCount: countRow.c,
          columns: cols.map(c => ({ name: c.name, type: c.type, pii: classifyColumn(c.name) })),
        });
      } catch { }
    }
    return { path: dbPath, format: 'sqlite', tables: mapped };
  } catch {
    return null;
  } finally {
    if (db !== null) {
      try { db.close(); } catch { }
    }
  }
}
