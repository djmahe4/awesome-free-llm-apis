import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  classifyColumn,
  createPersonPseudonymizer,
  sanitizeText,
  WorkspaceDirScanner,
  scanWorkspace,
} from '../src/harness/dir-scanner.js';
import { removeDir } from './helpers/temp-dir.js';

const tempDirs: string[] = [];
afterAll(async () => {
  for (const dir of tempDirs) await removeDir(dir);
});

function mktemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('classifyColumn', () => {
  it('classifies secret tokens', () => {
    expect(classifyColumn('api_key')).toBe('secret');
    expect(classifyColumn('password')).toBe('secret');
    expect(classifyColumn('staged_commit_hash')).toBe('secret');
    expect(classifyColumn('auth')).toBe('secret');
  });

  it('classifies email and phone', () => {
    expect(classifyColumn('email')).toBe('email');
    expect(classifyColumn('reply_e_mail')).toBe('email');
    expect(classifyColumn('phone')).toBe('phone');
    expect(classifyColumn('mobile')).toBe('phone');
  });

  it('classifies person-like columns', () => {
    expect(classifyColumn('author')).toBe('person');
    expect(classifyColumn('user')).toBe('person');
    expect(classifyColumn('owner')).toBe('person');
  });

  it('does not classify technical name columns as person', () => {
    expect(classifyColumn('file_name')).toBeNull();
    expect(classifyColumn('column_name')).toBeNull();
    expect(classifyColumn('db_path')).toBeNull();
    expect(classifyColumn('nick_name')).toBeNull();
    expect(classifyColumn('host_name')).toBeNull();
  });

  it('returns null for plain columns', () => {
    expect(classifyColumn('content')).toBeNull();
    expect(classifyColumn('updated_at')).toBeNull();
    expect(classifyColumn('id')).toBeNull();
  });
});

describe('createPersonPseudonymizer', () => {
  it('aliases two-word TitleCase names consistently', () => {
    const p = createPersonPseudonymizer();
    expect(p.aliasValue('John Smith')).toBe('person1');
    expect(p.aliasValue('John Smith')).toBe('person1');
    expect(p.aliasValue('Maria Lopez')).toBe('person2');
    expect(p.knownCount()).toBe(2);
  });

  it('rejects short values, digits, special chars and single words', () => {
    const p = createPersonPseudonymizer();
    expect(p.aliasValue('js')).toBe('js');
    expect(p.aliasValue('Alice')).toBe('Alice');
    expect(p.aliasValue('John Smith2')).toBe('John Smith2');
    expect(p.aliasValue('user@example.com')).toBe('user@example.com');
    expect(p.knownCount()).toBe(0);
  });

  it('rejects stopword words', () => {
    const p = createPersonPseudonymizer();
    expect(p.aliasValue('The Zed Files')).toBe('The Zed Files');
    expect(p.knownCount()).toBe(0);
  });

  it('pseudonymize replaces known names case-insensitively and learns new bigrams', () => {
    const p = createPersonPseudonymizer();
    p.aliasValue('John Smith');
    const out = p.pseudonymize('john smith wrote code and JOHN SMITH too');
    expect(out).toBe('person1 wrote code and person1 too');
    const learned = p.pseudonymize('met Maria Lopez today');
    expect(learned).toBe('met person2 today');
  });

  it('pseudonymize redacts secrets via Sanitizer first', () => {
    const p = createPersonPseudonymizer();
    const out = p.pseudonymize('token=sk-ant-abcdefghij0123456789');
    expect(out).not.toContain('sk-ant-');
  });
});

describe('sanitizeText', () => {
  it('applies pseudonymizer when given', () => {
    const p = createPersonPseudonymizer();
    expect(sanitizeText('John Smith', p)).toBe('person1');
  });

  it('falls back to Sanitizer only', () => {
    expect(sanitizeText('plain text')).toBe('plain text');
  });
});

describe('WorkspaceDirScanner.scanDir', () => {
  it('scans files, subdirs, respects skip dirs and depth', () => {
    const root = mktemp('dirscan-base-');
    fs.writeFileSync(path.join(root, 'a.ts'), 'const a = 1;\n');
    fs.writeFileSync(path.join(root, 'b.md'), '# hi\n');
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'hidden.js'), 'x');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'x');
    fs.mkdirSync(path.join(root, 'deep'));
    fs.mkdirSync(path.join(root, 'deep', 'deeper'));

    const res = new WorkspaceDirScanner(root).scanDir({ maxDepth: 1, filesPerFolder: 5, mapDbs: false });
    const rootFolder = res.folders.find(f => f.depth === 0);
    expect(rootFolder).toBeDefined();
    expect(rootFolder!.files.map(f => f.name)).toEqual(['a.ts', 'b.md']);
    expect(rootFolder!.subdirs).toBe(2);
    expect(res.truncated).toBe(true);
  });

  it('truncates files beyond filesPerFolder', () => {
    const root = mktemp('dirscan-trunc-');
    for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x');
    const res = new WorkspaceDirScanner(root).scanDir({ mapDbs: false });
    expect(res.folders[0].files).toHaveLength(5);
    expect(res.truncated).toBe(true);
  });

  it('maps sqlite schema with PII classification and row counts', () => {
    const root = mktemp('dirscan-db-');
    const dbPath = path.join(root, 'notes.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE thoughts (id TEXT, author TEXT, content TEXT, email TEXT)');
    db.prepare('INSERT INTO thoughts (id, author, content, email) VALUES (?, ?, ?, ?)')
      .run('t1', 'John Smith', 'hello', 'a@b.c');
    db.prepare('INSERT INTO thoughts (id, author, content, email) VALUES (?, ?, ?, ?)')
      .run('t2', 'Jane Doe', 'world', 'd@e.f');
    db.exec('CREATE TABLE meta (key TEXT, value TEXT)');
    db.close();

    const res = new WorkspaceDirScanner(root).scanDir();
    const rootFolder = res.folders[0];
    expect(rootFolder.dbs).toHaveLength(1);
    const mapped = rootFolder.dbs![0];
    expect(mapped.format).toBe('sqlite');
    expect(mapped.path).toBe(dbPath);
    const tables = Object.fromEntries(mapped.tables.map(t => [t.name, t]));
    expect(tables['thoughts'].rowCount).toBe(2);
    const cols = Object.fromEntries(tables['thoughts'].columns.map(c => [c.name, c.pii]));
    expect(cols['author']).toBe('person');
    expect(cols['email']).toBe('email');
    expect(cols['content']).toBeNull();
    expect(tables['meta'].rowCount).toBe(0);
  });

  it('ignores .db files without the sqlite magic', () => {
    const root = mktemp('dirscan-junk-');
    fs.writeFileSync(path.join(root, 'junk.db'), 'not a database at all');
    const res = new WorkspaceDirScanner(root).scanDir();
    expect(res.folders[0].dbs).toBeUndefined();
  });

  it('excludes sqlite internal tables', () => {
    const root = mktemp('dirscan-sq-');
    const dbPath = path.join(root, 't.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE visible (a TEXT)');
    db.close();
    const res = new WorkspaceDirScanner(root).scanDir();
    const names = res.folders[0].dbs![0].tables.map(t => t.name);
    expect(names).toContain('visible');
    expect(names.some(n => n.startsWith('sqlite_'))).toBe(false);
  });
});

describe('scanWorkspace', () => {
  it('accepts snake_case args', async () => {
    const root = mktemp('dirscan-args-');
    fs.writeFileSync(path.join(root, 'x.ts'), 'x');
    const res = await scanWorkspace({ workspace_root: root, map_dbs: false });
    expect(res.root).toBe(root);
    expect(res.folders).toHaveLength(1);
    expect(res.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
