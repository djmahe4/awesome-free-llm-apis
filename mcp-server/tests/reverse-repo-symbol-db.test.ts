import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RepoSymbolDb, type RepoKnowledgeRecord } from '../src/reverse/repo-symbol-db.js';

describe('RepoSymbolDb and Wiki Knowledge Generator', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-db-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores and retrieves repo symbol knowledge by owner/repo/sha', () => {
    const db = new RepoSymbolDb(tmpDir);
    const record: RepoKnowledgeRecord = {
      owner: 'acme',
      repo: 'core-service',
      commitSha: 'a1b2c3d4',
      indexedAt: new Date().toISOString(),
      symbols: [
        { name: 'startServer', kind: 'function', line: 12, filePath: 'src/server.ts' },
      ],
      callFlows: ['startServer -> initDatabase'],
      manifests: ['package.json'],
      dependencies: [{ name: 'express', spec: '^4.18' }],
      releaseAssets: [],
    };

    db.saveRecord(record);
    const retrieved = db.getRecord('acme', 'core-service', 'a1b2c3d4');

    expect(retrieved).toBeDefined();
    expect(retrieved?.repo).toBe('core-service');
    expect(retrieved?.symbols).toHaveLength(1);
    expect(retrieved?.callFlows).toContain('startServer -> initDatabase');
  });

  it('synthesizes markdown wiki entry and detects static vs ground-truth discrepancies', () => {
    const db = new RepoSymbolDb(tmpDir);
    const record: RepoKnowledgeRecord = {
      owner: 'org',
      repo: 'deceptive-app',
      commitSha: '11223344',
      indexedAt: new Date().toISOString(),
      readmeClaims: ['Distributed gRPC microservice architecture', 'Cloud hardware enclave'],
      symbols: [{ name: 'localCalc', kind: 'function', line: 5, filePath: 'app.js' }],
      callFlows: [],
      manifests: ['package.json'],
      dependencies: [],
      releaseAssets: [],
    };

    const wikiMd = db.generateWikiMarkdown(record);
    expect(wikiMd).toContain('# Repository Knowledge: org/deceptive-app');
    expect(wikiMd).toContain('localCalc');
    expect(wikiMd).toContain('Anti-BLA Deception / Discrepancy Warnings');
  });

  it('rejects invalid records and handles malformed or array JSON in getRecord', () => {
    const db = new RepoSymbolDb(tmpDir);
    const targetFile = path.join(tmpDir, 'test_repo_123.json');

    // Write an array
    fs.writeFileSync(targetFile, JSON.stringify(['not', 'an', 'object']));
    expect(db.getRecord('test', 'repo', '123')).toBeNull();

    // Write null / primitive
    fs.writeFileSync(targetFile, 'null');
    expect(db.getRecord('test', 'repo', '123')).toBeNull();

    fs.writeFileSync(targetFile, '12345');
    expect(db.getRecord('test', 'repo', '123')).toBeNull();
  });

  it('handles record with missing optional array fields in generateWikiMarkdown', () => {
    const db = new RepoSymbolDb(tmpDir);
    const minimalRecord = {
      owner: 'acme',
      repo: 'sparse',
      commitSha: '999',
      indexedAt: '2026-01-01T00:00:00Z',
    } as unknown as RepoKnowledgeRecord;

    const wikiMd = db.generateWikiMarkdown(minimalRecord);
    expect(wikiMd).toContain('# Repository Knowledge: acme/sparse');
    expect(wikiMd).toContain('None found');
  });
});
