import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DiskSymbolDb, type DagNodeRecord, type DagEdgeRecord } from '../src/memory/disk-symbol-db.js';

describe('DiskSymbolDb: Zero-OOM Paged SQLite Storage Engine', () => {
  let tmpDir: string;
  let db: DiskSymbolDb;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `test-disk-symbol-db-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    db = new DiskSymbolDb({
      baseDir: tmpDir,
      maxMemoryBytes: 2 * 1024 * 1024, // 2MB small ceiling for testing eviction
    });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('persists and retrieves nodes without holding entire dataset in RAM', () => {
    const node: DagNodeRecord = {
      id: 'auth::validate_token',
      kind: 'function',
      scope: 'auth::jwt',
      filePath: 'src/auth/jwt.ts',
      lineStart: 45,
      lineEnd: 70,
      signature: 'validate_token(token: string): Claims',
      docstring: 'Validates HMAC signature and expiration of JWT.',
      tags: ['auth', 'crypto'],
    };

    db.putNode('repo_hash_1', node);
    const retrieved = db.getNode('repo_hash_1', 'auth::validate_token');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe('auth::validate_token');
    expect(retrieved?.signature).toBe(node.signature);
    expect(retrieved?.scope).toBe('auth::jwt');
    expect(retrieved?.tags).toEqual(['auth', 'crypto']);
  });

  it('evicts pages from memory while preserving persistent disk records', () => {
    // Generate 500 nodes to exceed the 2MB test memory ceiling
    for (let i = 0; i < 500; i++) {
      db.putNode('repo_hash_1', {
        id: `symbol_${i}`,
        kind: 'function',
        scope: 'module_a',
        filePath: `src/file_${i}.ts`,
        lineStart: 1,
        lineEnd: 20,
        signature: `symbol_${i}(arg: string): void`,
        payload: 'x'.repeat(10000), // 10KB payload
      });
    }

    expect(db.getMemoryResidentBytes()).toBeLessThanOrEqual(2 * 1024 * 1024);
    // Node 0 should be evicted from RAM but immediately loadable from disk
    const node0 = db.getNode('repo_hash_1', 'symbol_0');
    expect(node0).not.toBeNull();
    expect(node0?.id).toBe('symbol_0');
    expect(node0?.payload?.length).toBe(10000);
  });

  it('persists and queries directional edges with indexing', () => {
    const edge: DagEdgeRecord = {
      source: 'api::handle_login',
      target: 'auth::validate_token',
      kind: 'invokes',
      confidence: 'high',
      metadata: { callSiteLine: 52 },
    };

    db.putEdge('repo_hash_1', edge);
    const outgoing = db.getEdgesFrom('repo_hash_1', 'api::handle_login');
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].target).toBe('auth::validate_token');
    expect(outgoing[0].metadata).toEqual({ callSiteLine: 52 });

    const incoming = db.getEdgesTo('repo_hash_1', 'auth::validate_token');
    expect(incoming).toHaveLength(1);
    expect(incoming[0].source).toBe('api::handle_login');
  });

  it('queries nodes by scope and file path', () => {
    db.putNode('repo_hash_2', {
      id: 'modA::fn1',
      kind: 'function',
      scope: 'modA',
      filePath: 'src/modA.ts',
    });
    db.putNode('repo_hash_2', {
      id: 'modA::fn2',
      kind: 'function',
      scope: 'modA',
      filePath: 'src/modA.ts',
    });
    db.putNode('repo_hash_2', {
      id: 'modB::fn3',
      kind: 'function',
      scope: 'modB',
      filePath: 'src/modB.ts',
    });

    const inScope = db.getNodesByScope('repo_hash_2', 'modA');
    expect(inScope).toHaveLength(2);
    expect(inScope.map(n => n.id)).toEqual(['modA::fn1', 'modA::fn2']);

    const inFile = db.getNodesByFile('repo_hash_2', 'src/modA.ts');
    expect(inFile).toHaveLength(2);
  });

  it('rolls back batch writes on transaction error', () => {
    expect(() => {
      db.transaction(() => {
        db.putNode('repo_hash_tx', {
          id: 'tx::node_1',
          kind: 'function',
          filePath: 'src/tx.ts',
        });
        throw new Error('Simulated batch failure');
      });
    }).toThrow('Simulated batch failure');

    const node = db.getNode('repo_hash_tx', 'tx::node_1');
    expect(node).toBeNull();
  });

  it('protects cached nodes from caller mutations (structuredClone)', () => {
    const original: DagNodeRecord = {
      id: 'clone::test',
      kind: 'function',
      filePath: 'src/clone.ts',
      tags: ['immutable'],
      metadata: { nested: { val: 1 } },
    };
    db.putNode('repo_clone', original);

    // Mutate original object
    original.tags?.push('mutated_original');
    original.metadata!.nested.val = 999;

    const retrieved1 = db.getNode('repo_clone', 'clone::test');
    expect(retrieved1?.tags).toEqual(['immutable']);
    expect(retrieved1?.metadata?.nested?.val).toBe(1);

    // Mutate retrieved object
    retrieved1?.tags?.push('mutated_retrieved');
    retrieved1!.metadata!.nested.val = 555;

    const retrieved2 = db.getNode('repo_clone', 'clone::test');
    expect(retrieved2?.tags).toEqual(['immutable']);
    expect(retrieved2?.metadata?.nested?.val).toBe(1);
  });

  it('handles malformed or non-array tags safely in rowToNode', () => {
    // Inject node with non-array JSON in tags via direct SQLite or mock
    db.putNode('repo_tags', {
      id: 'tags::test',
      kind: 'function',
      filePath: 'src/tags.ts',
      tags: ['a', 'b'],
    });
    // Corrupt tags directly in SQLite table
    (db as any).db.exec("UPDATE dag_nodes SET tags = '\"not-an-array\"' WHERE id = 'tags::test';");
    // Clear cache to force DB read
    (db as any).nodeCache.clear();

    const node1 = db.getNode('repo_tags', 'tags::test');
    expect(node1?.tags).toEqual([]);

    (db as any).db.exec("UPDATE dag_nodes SET tags = 'invalid-json' WHERE id = 'tags::test';");
    (db as any).nodeCache.clear();
    const node2 = db.getNode('repo_tags', 'tags::test');
    expect(node2?.tags).toEqual([]);
  });

  it('guards public methods when closed and allows idempotent close', () => {
    db.close();
    expect(() => db.close()).not.toThrow();

    expect(() => db.getNode('r', 'id')).toThrow('DiskSymbolDb is closed');
    expect(() => db.putNode('r', { id: '1', kind: 'function', filePath: 'a' })).toThrow('DiskSymbolDb is closed');
    expect(() => db.getNodesByScope('r', 's')).toThrow('DiskSymbolDb is closed');
    expect(() => db.getNodesByFile('r', 'f')).toThrow('DiskSymbolDb is closed');
    expect(() => db.getAllNodes('r')).toThrow('DiskSymbolDb is closed');
    expect(() => db.putEdge('r', { source: 'a', target: 'b', kind: 'invokes' })).toThrow('DiskSymbolDb is closed');
    expect(() => db.getEdgesFrom('r', 'a')).toThrow('DiskSymbolDb is closed');
    expect(() => db.getEdgesTo('r', 'b')).toThrow('DiskSymbolDb is closed');
    expect(() => db.getAllEdges('r')).toThrow('DiskSymbolDb is closed');
    expect(() => db.getMemoryResidentBytes()).toThrow('DiskSymbolDb is closed');
    expect(() => db.transaction(() => {})).toThrow('DiskSymbolDb is closed');
    expect(() => db.deleteNodesByFile('r', 'f')).toThrow('DiskSymbolDb is closed');
    expect(() => db.deleteRepo('r')).toThrow('DiskSymbolDb is closed');
  });

  it('deleteNodesByFile deletes nodes from db and evicts from cache', () => {
    db.putNode('repo_del', {
      id: 'file1::n1',
      kind: 'function',
      filePath: 'src/file1.ts',
    });
    db.putNode('repo_del', {
      id: 'file1::n2',
      kind: 'function',
      filePath: 'src/file1.ts',
    });
    db.putNode('repo_del', {
      id: 'file2::n3',
      kind: 'function',
      filePath: 'src/file2.ts',
    });

    // Both should be in cache
    expect(db.getNode('repo_del', 'file1::n1')).not.toBeNull();
    db.deleteNodesByFile('repo_del', 'src/file1.ts');

    expect(db.getNode('repo_del', 'file1::n1')).toBeNull();
    expect(db.getNode('repo_del', 'file1::n2')).toBeNull();
    expect(db.getNode('repo_del', 'file2::n3')).not.toBeNull();
    expect(db.getNodesByFile('repo_del', 'src/file1.ts')).toHaveLength(0);
    expect(db.getNodesByFile('repo_del', 'src/file2.ts')).toHaveLength(1);
  });

  it('verifies deleteNodesByFile removes both nodes and connected edges', () => {
    db.putNode('repo_edges', { id: 'file1::n1', kind: 'function', filePath: 'src/file1.ts' });
    db.putNode('repo_edges', { id: 'file1::n2', kind: 'function', filePath: 'src/file1.ts' });
    db.putNode('repo_edges', { id: 'file2::n3', kind: 'function', filePath: 'src/file2.ts' });

    db.putEdge('repo_edges', { source: 'file1::n1', target: 'file2::n3', kind: 'invokes' });
    db.putEdge('repo_edges', { source: 'file2::n3', target: 'file1::n2', kind: 'invokes' });
    db.putEdge('repo_edges', { source: 'file2::n3', target: 'file2::n3', kind: 'invokes' });

    db.deleteNodesByFile('repo_edges', 'src/file1.ts');

    expect(db.getNode('repo_edges', 'file1::n1')).toBeNull();
    expect(db.getNode('repo_edges', 'file1::n2')).toBeNull();
    expect(db.getNode('repo_edges', 'file2::n3')).not.toBeNull();

    const remainingEdges = db.getAllEdges('repo_edges');
    expect(remainingEdges).toHaveLength(1);
    expect(remainingEdges[0]).toEqual({
      source: 'file2::n3',
      target: 'file2::n3',
      kind: 'invokes',
    });
  });

  it('deleteRepo deletes all nodes, edges and cache for that repo', () => {
    db.putNode('repo_r1', { id: 'r1::n1', kind: 'function', filePath: 'src/a.ts' });
    db.putNode('repo_r2', { id: 'r2::n1', kind: 'function', filePath: 'src/b.ts' });
    db.putEdge('repo_r1', { source: 'r1::n1', target: 'r1::n2', kind: 'invokes' });
    db.putEdge('repo_r2', { source: 'r2::n1', target: 'r2::n2', kind: 'invokes' });

    db.deleteRepo('repo_r1');

    expect(db.getNode('repo_r1', 'r1::n1')).toBeNull();
    expect(db.getAllNodes('repo_r1')).toHaveLength(0);
    expect(db.getAllEdges('repo_r1')).toHaveLength(0);

    expect(db.getNode('repo_r2', 'r2::n1')).not.toBeNull();
    expect(db.getAllNodes('repo_r2')).toHaveLength(1);
    expect(db.getAllEdges('repo_r2')).toHaveLength(1);
  });
});
