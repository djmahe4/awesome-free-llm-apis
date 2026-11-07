import { DatabaseSync, StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getMcpDir } from '../utils/mcp-home.js';

export interface DagNodeRecord {
  id: string;
  kind: 'module' | 'class' | 'struct' | 'interface' | 'trait' | 'function' | 'method' | 'sink' | 'concept';
  scope?: string;
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  signature?: string;
  docstring?: string;
  tags?: string[];
  payload?: string;
  metadata?: Record<string, any>;
}

export interface DagEdgeRecord {
  source: string;
  target: string;
  kind: 'imports' | 'references' | 'invokes' | 'contains' | 'implements' | 'taints';
  confidence?: 'high' | 'medium' | 'low';
  metadata?: Record<string, any>;
}

export interface DiskSymbolDbOptions {
  baseDir?: string;
  maxMemoryBytes?: number;
}

interface CachedNodeEntry {
  node: DagNodeRecord;
  size: number;
}

export class DiskSymbolDb {
  private db: DatabaseSync;
  private maxMemoryBytes: number;
  private currentMemoryBytes = 0;
  private nodeCache = new Map<string, CachedNodeEntry>();
  private isClosed = false;

  private stmtPutNode: StatementSync;
  private stmtGetNode: StatementSync;
  private stmtGetNodesByScope: StatementSync;
  private stmtGetNodesByFile: StatementSync;
  private stmtGetAllNodes: StatementSync;
  private stmtPutEdge: StatementSync;
  private stmtGetEdgesFrom: StatementSync;
  private stmtGetEdgesTo: StatementSync;
  private stmtGetAllEdges: StatementSync;
  private stmtDeleteNodesByFile: StatementSync;
  private stmtDeleteRepoNodes: StatementSync;
  private stmtDeleteRepoEdges: StatementSync;

  constructor(options?: DiskSymbolDbOptions) {
    let baseDir = options?.baseDir;
    if (!baseDir) {
      try {
        baseDir = path.join(getMcpDir(), 'graphs');
      } catch (err) {
        if (process.env.VITEST) throw err;
        baseDir = path.join(os.homedir(), '.free-llm-mcp', 'graphs');
      }
    }

    this.maxMemoryBytes = options?.maxMemoryBytes ?? 32 * 1024 * 1024;

    fs.mkdirSync(baseDir, { recursive: true });
    const dbPath = path.join(baseDir, 'symbols.db');
    this.db = new DatabaseSync(dbPath);

    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dag_nodes (
        repo_hash TEXT NOT NULL,
        id TEXT NOT NULL,
        kind TEXT NOT NULL,
        scope TEXT,
        file_path TEXT NOT NULL,
        line_start INTEGER,
        line_end INTEGER,
        signature TEXT,
        docstring TEXT,
        tags TEXT,
        payload TEXT,
        metadata TEXT,
        PRIMARY KEY (repo_hash, id)
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_scope ON dag_nodes (repo_hash, scope);
      CREATE INDEX IF NOT EXISTS idx_nodes_file ON dag_nodes (repo_hash, file_path);

      CREATE TABLE IF NOT EXISTS dag_edges (
        repo_hash TEXT NOT NULL,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        kind TEXT NOT NULL,
        confidence TEXT,
        metadata TEXT,
        PRIMARY KEY (repo_hash, source, target, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_edges_source ON dag_edges (repo_hash, source);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON dag_edges (repo_hash, target);
    `);

    this.stmtPutNode = this.db.prepare(`
      INSERT OR REPLACE INTO dag_nodes (
        repo_hash, id, kind, scope, file_path, line_start, line_end, signature, docstring, tags, payload, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetNode = this.db.prepare(`
      SELECT repo_hash, id, kind, scope, file_path, line_start, line_end, signature, docstring, tags, payload, metadata
      FROM dag_nodes WHERE repo_hash = ? AND id = ?
    `);

    this.stmtGetNodesByScope = this.db.prepare(`
      SELECT repo_hash, id, kind, scope, file_path, line_start, line_end, signature, docstring, tags, payload, metadata
      FROM dag_nodes WHERE repo_hash = ? AND scope = ?
    `);

    this.stmtGetNodesByFile = this.db.prepare(`
      SELECT repo_hash, id, kind, scope, file_path, line_start, line_end, signature, docstring, tags, payload, metadata
      FROM dag_nodes WHERE repo_hash = ? AND file_path = ?
    `);

    this.stmtGetAllNodes = this.db.prepare(`
      SELECT repo_hash, id, kind, scope, file_path, line_start, line_end, signature, docstring, tags, payload, metadata
      FROM dag_nodes WHERE repo_hash = ?
    `);

    this.stmtPutEdge = this.db.prepare(`
      INSERT OR REPLACE INTO dag_edges (
        repo_hash, source, target, kind, confidence, metadata
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetEdgesFrom = this.db.prepare(`
      SELECT repo_hash, source, target, kind, confidence, metadata
      FROM dag_edges WHERE repo_hash = ? AND source = ?
    `);

    this.stmtGetEdgesTo = this.db.prepare(`
      SELECT repo_hash, source, target, kind, confidence, metadata
      FROM dag_edges WHERE repo_hash = ? AND target = ?
    `);

    this.stmtGetAllEdges = this.db.prepare(`
      SELECT repo_hash, source, target, kind, confidence, metadata
      FROM dag_edges WHERE repo_hash = ?
    `);

    this.stmtDeleteNodesByFile = this.db.prepare(`
      DELETE FROM dag_nodes WHERE repo_hash = ? AND file_path = ?
    `);

    this.stmtDeleteRepoNodes = this.db.prepare(`
      DELETE FROM dag_nodes WHERE repo_hash = ?
    `);

    this.stmtDeleteRepoEdges = this.db.prepare(`
      DELETE FROM dag_edges WHERE repo_hash = ?
    `);
  }

  private estimateNodeSize(node: DagNodeRecord): number {
    let bytes = 128;
    if (node.id) bytes += node.id.length * 2;
    if (node.kind) bytes += node.kind.length * 2;
    if (node.scope) bytes += node.scope.length * 2;
    if (node.filePath) bytes += node.filePath.length * 2;
    if (node.signature) bytes += node.signature.length * 2;
    if (node.docstring) bytes += node.docstring.length * 2;
    if (node.payload) bytes += node.payload.length * 2;
    if (node.lineStart !== undefined) bytes += 8;
    if (node.lineEnd !== undefined) bytes += 8;
    if (node.tags) {
      bytes += 32;
      for (const tag of node.tags) {
        bytes += tag.length * 2 + 16;
      }
    }
    if (node.metadata) {
      bytes += 64 + JSON.stringify(node.metadata).length * 2;
    }
    return bytes;
  }

  private cacheNode(key: string, node: DagNodeRecord): void {
    const cloned = structuredClone(node);
    const existing = this.nodeCache.get(key);
    if (existing) {
      this.currentMemoryBytes -= existing.size;
      this.nodeCache.delete(key);
    }

    const size = this.estimateNodeSize(cloned);
    if (size > this.maxMemoryBytes) {
      return;
    }

    this.nodeCache.set(key, { node: cloned, size });
    this.currentMemoryBytes += size;

    while (this.currentMemoryBytes > this.maxMemoryBytes && this.nodeCache.size > 0) {
      const oldestKey = this.nodeCache.keys().next().value;
      if (!oldestKey) break;
      const entry = this.nodeCache.get(oldestKey);
      if (entry) {
        this.currentMemoryBytes -= entry.size;
      }
      this.nodeCache.delete(oldestKey);
    }
  }

  private rowToNode(row: any): DagNodeRecord {
    const node: DagNodeRecord = {
      id: String(row.id),
      kind: row.kind,
      filePath: String(row.file_path),
    };
    if (row.scope != null) node.scope = String(row.scope);
    if (row.line_start != null) node.lineStart = Number(row.line_start);
    if (row.line_end != null) node.lineEnd = Number(row.line_end);
    if (row.signature != null) node.signature = String(row.signature);
    if (row.docstring != null) node.docstring = String(row.docstring);
    if (row.payload != null) node.payload = String(row.payload);
    if (row.tags != null) {
      try {
        const parsed = JSON.parse(row.tags);
        node.tags = Array.isArray(parsed) ? parsed : [];
      } catch {
        node.tags = [];
      }
    }
    if (row.metadata != null) {
      try {
        node.metadata = JSON.parse(row.metadata);
      } catch {
        node.metadata = {};
      }
    }
    return node;
  }

  private rowToEdge(row: any): DagEdgeRecord {
    const edge: DagEdgeRecord = {
      source: String(row.source),
      target: String(row.target),
      kind: row.kind,
    };
    if (row.confidence != null) edge.confidence = row.confidence;
    if (row.metadata != null) {
      try {
        edge.metadata = JSON.parse(row.metadata);
      } catch {
        edge.metadata = {};
      }
    }
    return edge;
  }

  putNode(repoHash: string, node: DagNodeRecord): void {
    if (this.isClosed) throw new Error('DiskSymbolDb is closed');
    this.stmtPutNode.run(
      repoHash,
      node.id,
      node.kind,
      node.scope ?? null,
      node.filePath,
      node.lineStart ?? null,
      node.lineEnd ?? null,
      node.signature ?? null,
      node.docstring ?? null,
      node.tags ? JSON.stringify(node.tags) : null,
      node.payload ?? null,
      node.metadata ? JSON.stringify(node.metadata) : null,
    );

    const key = `${repoHash}::${node.id}`;
    this.cacheNode(key, node);
  }

  getNode(repoHash: string, id: string): DagNodeRecord | null {
    if (this.isClosed) throw new Error('DiskSymbolDb is closed');
    const key = `${repoHash}::${id}`;
    const cached = this.nodeCache.get(key);
    if (cached) {
      this.nodeCache.delete(key);
      this.nodeCache.set(key, cached);
      return structuredClone(cached.node);
    }

    const row = this.stmtGetNode.get(repoHash, id) as any;
    if (!row) return null;

    const node = this.rowToNode(row);
    this.cacheNode(key, node);
    return structuredClone(node);
  }

  getNodesByScope(repoHash: string, scope: string): DagNodeRecord[] {
    if (this.isClosed) throw new Error('DiskSymbolDb is closed');
    const rows = this.stmtGetNodesByScope.all(repoHash, scope) as any[];
    return rows.map((r) => this.rowToNode(r));
  }

  getNodesByFile(repoHash: string, filePath: string): DagNodeRecord[] {
    if (this.isClosed) throw new Error('DiskSymbolDb is closed');
    const rows = this.stmtGetNodesByFile.all(repoHash, filePath) as any[];
    return rows.map((r) => this.rowToNode(r));
  }

  getAllNodes(repoHash: string): DagNodeRecord[] {
    if (this.isClosed) throw new Error('DiskSymbolDb is closed');
    const rows = this.stmtGetAllNodes.all(repoHash) as any[];
    return rows.map((r) => this.rowToNode(r));
  }

  putEdge(repoHash: string, edge: DagEdgeRecord): void {
    if (this.isClosed) throw new Error('DiskSymbolDb is closed');
    this.stmtPutEdge.run(
      repoHash,
      edge.source,
      edge.target,
      edge.kind,
      edge.confidence ?? null,
      edge.metadata ? JSON.stringify(edge.metadata) : null,
    );
  }

  getEdgesFrom(repoHash: string, source: string): DagEdgeRecord[] {
    if (this.isClosed) throw new Error('DiskSymbolDb is closed');
    const rows = this.stmtGetEdgesFrom.all(repoHash, source) as any[];
    return rows.map((r) => this.rowToEdge(r));
  }

  getEdgesTo(repoHash: string, target: string): DagEdgeRecord[] {
    if (this.isClosed) throw new Error('DiskSymbolDb is closed');
    const rows = this.stmtGetEdgesTo.all(repoHash, target) as any[];
    return rows.map((r) => this.rowToEdge(r));
  }

  getAllEdges(repoHash: string): DagEdgeRecord[] {
    if (this.isClosed) throw new Error('DiskSymbolDb is closed');
    const rows = this.stmtGetAllEdges.all(repoHash) as any[];
    return rows.map((r) => this.rowToEdge(r));
  }

  deleteNodesByFile(repoHash: string, filePath: string): void {
    if (this.isClosed) throw new Error('DiskSymbolDb is closed');
    this.stmtDeleteNodesByFile.run(repoHash, filePath);
    for (const [key, entry] of this.nodeCache.entries()) {
      if (key.startsWith(`${repoHash}::`) && entry.node.filePath === filePath) {
        this.currentMemoryBytes -= entry.size;
        this.nodeCache.delete(key);
      }
    }
  }

  deleteRepo(repoHash: string): void {
    if (this.isClosed) throw new Error('DiskSymbolDb is closed');
    this.stmtDeleteRepoNodes.run(repoHash);
    this.stmtDeleteRepoEdges.run(repoHash);
    for (const [key, entry] of this.nodeCache.entries()) {
      if (key.startsWith(`${repoHash}::`)) {
        this.currentMemoryBytes -= entry.size;
        this.nodeCache.delete(key);
      }
    }
  }

  getMemoryResidentBytes(): number {
    if (this.isClosed) throw new Error('DiskSymbolDb is closed');
    return this.currentMemoryBytes;
  }

  transaction<T>(fn: () => T): T {
    if (this.isClosed) throw new Error('DiskSymbolDb is closed');
    this.db.exec('BEGIN IMMEDIATE;');
    const cacheBackup = new Map(this.nodeCache);
    const memBackup = this.currentMemoryBytes;
    try {
      const res = fn();
      this.db.exec('COMMIT;');
      return res;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {}
      this.nodeCache = cacheBackup;
      this.currentMemoryBytes = memBackup;
      throw err;
    }
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.nodeCache.clear();
    this.currentMemoryBytes = 0;
    this.db.close();
  }
}
