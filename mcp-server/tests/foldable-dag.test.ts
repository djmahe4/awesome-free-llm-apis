import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FoldableDag, type FoldedModuleSummary, type BlastRadiusReport } from '../src/memory/foldable-dag.js';
import { DiskSymbolDb } from '../src/memory/disk-symbol-db.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

describe('FoldableDag: Multi-Scale Conceptual Folding & Blast Radius', () => {
  let tmpDir: string;
  let db: DiskSymbolDb;
  let dag: FoldableDag;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `test-foldable-dag-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    db = new DiskSymbolDb({ baseDir: tmpDir });
    dag = new FoldableDag(db, 'repo_test_1');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('folds fine-grained AST symbols into high-level conceptual modules', () => {
    dag.addSymbol({ id: 'auth::jwt::sign', module: 'auth', kind: 'function', filePath: 'src/auth/jwt.ts' });
    dag.addSymbol({ id: 'auth::jwt::verify', module: 'auth', kind: 'function', filePath: 'src/auth/jwt.ts' });
    dag.addSymbol({ id: 'db::pool::query', module: 'database', kind: 'function', filePath: 'src/db/pool.ts' });

    const folded = dag.getFoldedSummary();
    expect(folded.modules).toHaveLength(2);

    const authMod = folded.modules.find((m) => m.name === 'auth');
    expect(authMod).toBeDefined();
    expect(authMod?.symbolCount).toBe(2);

    const dbMod = folded.modules.find((m) => m.name === 'database');
    expect(dbMod).toBeDefined();
    expect(dbMod?.symbolCount).toBe(1);
  });

  it('unfolds target module subtree on demand for focused subtask routing', () => {
    dag.addSymbol({ id: 'auth::jwt::sign', module: 'auth', kind: 'function', filePath: 'src/auth/jwt.ts' });
    dag.addSymbol({ id: 'auth::jwt::verify', module: 'auth', kind: 'function', filePath: 'src/auth/jwt.ts' });
    dag.addSymbol({ id: 'db::pool::query', module: 'database', kind: 'function', filePath: 'src/db/pool.ts' });

    const subtree = dag.unfoldModule('auth');
    expect(subtree.symbols.map((s) => s.id).sort()).toEqual(['auth::jwt::sign', 'auth::jwt::verify'].sort());
    expect(subtree.symbols.some((s) => s.id === 'db::pool::query')).toBe(false);
  });

  it('computes upstream blast radius when a symbol signature breaks', () => {
    // caller_a -> helper_b -> target_c
    dag.addSymbol({ id: 'caller_a', module: 'api', kind: 'function', filePath: 'src/api.ts' });
    dag.addSymbol({ id: 'helper_b', module: 'core', kind: 'function', filePath: 'src/helper.ts' });
    dag.addSymbol({ id: 'target_c', module: 'core', kind: 'function', filePath: 'src/target.ts' });

    dag.addInvocation('caller_a', 'helper_b');
    dag.addInvocation('helper_b', 'target_c');

    const blast = dag.computeBlastRadius('target_c');
    expect(blast.directCallers).toEqual(['helper_b']);
    expect(blast.transitiveCallers).toContain('caller_a');
    expect(blast.severity).toBe('moderate');
  });

  it('generates interactive user choice prompt when breaking changes exceed threshold', () => {
    dag.addSymbol({ id: 'target_c', module: 'core', kind: 'function', filePath: 'src/target.ts' });
    for (let i = 0; i < 6; i++) {
      dag.addSymbol({ id: `client_${i}`, module: 'apps', kind: 'function', filePath: `src/client_${i}.ts` });
      dag.addInvocation(`client_${i}`, 'target_c');
    }

    const prompt = dag.evaluateBreakingChangeAction('target_c', {
      changeType: 'signature_break',
      oldSignature: 'target_c(a: string)',
      newSignature: 'target_c(a: string, b: number)',
    });

    expect(prompt.requiresUserChoice).toBe(true);
    expect(prompt.directCallerCount).toBe(6);
    expect(prompt.options).toContainEqual(
      expect.objectContaining({
        id: 'backward_compatible_overload',
      })
    );
    expect(prompt.options).toContainEqual(
      expect.objectContaining({
        id: 'refactor_all_callers',
      })
    );
  });
});
