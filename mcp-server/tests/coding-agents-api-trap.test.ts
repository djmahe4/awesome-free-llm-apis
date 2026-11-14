import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withApiTrap } from '../src/tools/coding-agents/api-trap.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-trap-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function run(file: string, source: string, env: NodeJS.ProcessEnv = {}) {
  const p = path.join(dir, file);
  fs.writeFileSync(p, source);
  const r = spawnSync(process.execPath, ['--no-warnings', p], { cwd: dir, encoding: 'utf8', env: withApiTrap({ ...process.env, ...env }) });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const CJS = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
db.exec("CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('a')");
const stmt = db.prepare('SELECT id FROM t');
console.log('rows:', JSON.stringify(stmt.all()), 'get:', JSON.stringify(stmt.get()));
console.log('is array:', Array.isArray(stmt.all()));
const t = process.argv[2];
try { stmt.finalize(); } catch (e) { console.log('ERR', e.constructor.name, e.message); }
try { db.prepared('x'); } catch (e) { console.log('ERR2', e.message); }
db.close();
`;

describe('api trap', () => {
  it('lets real node:sqlite use through (CommonJS) and names the real members for a missing one', () => {
    const r = run('a.cjs', CJS);
    expect(r.out).toContain('rows: [{"id":"a"}]');
    expect(r.out).toContain('is array: true');
    expect(r.out).toMatch(/ERR TypeError .*has no member 'finalize'\. It has: .*\ball\b.*\bget\b.*\brun\b/);
    expect(r.out).toMatch(/ERR2 .*has no member 'prepared'\. It has: .*\bprepare\b/);
  });
  it('does the same for an ES module import', () => {
    const r = run('b.mjs', `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(':memory:');
const stmt = db.prepare('SELECT 1 AS n');
console.log('row:', JSON.stringify(stmt.get()));
try { stmt.finalize(); } catch (e) { console.log('ERR', e.message); }
`);
    expect(r.out).toContain('row: {"n":1}');
    expect(r.out).toMatch(/ERR .*has no member 'finalize'\. It has: .*\ball\b/);
  });
  it('leaves other modules and a disabled trap alone', () => {
    const plain = run('c.cjs', `const fs = require('node:fs'); console.log(typeof fs.readFileSync, fs.nonsense === undefined);`);
    expect(plain.out).toContain('function true');
    const off = run('d.cjs', CJS, { CODING_AGENTS_API_TRAP: '' });
    expect(off.out).toMatch(/ERR TypeError .*finalize is not a function/);
  });
});
