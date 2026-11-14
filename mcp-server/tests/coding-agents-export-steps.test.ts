import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deriveExportSteps, namesImportedFrom } from '../src/tools/coding-agents/export-steps.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function workspace(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-steps-'));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
const TEST = `import { a, b as bee } from '../src/mod.js';\nimport { other } from '../src/else.js';\nimport { v } from 'vitest';\n`;

describe('namesImportedFrom', () => {
  it('reads ESM and CJS imports of the target only', () => {
    expect(namesImportedFrom(TEST, 'tests/mod.test.ts', 'src/mod.ts')).toEqual(['a', 'b']);
    expect(namesImportedFrom(`const { x, y } = require("../src/mod.js");`, 'tests/m.test.js', 'src/mod.js')).toEqual(['x', 'y']);
  });
});

describe('deriveExportSteps', () => {
  const base = { goal: 'Rebuild the module', verifyCommand: 'npx vitest run tests/mod.test.ts', targetFiles: ['src/mod.ts'] };
  it('splits an empty module into one step per imported name, last one carrying the order', async () => {
    const root = workspace({ 'tests/mod.test.ts': TEST, 'src/mod.ts': '' });
    const steps = await deriveExportSteps({ ...base, workspaceRoot: root } as any);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toContain('`a`');
    expect(steps[0]).toContain('Start the file with the imports');
    expect(steps[1]).toContain('Append it at the end of the file');
    expect(steps[1]).toContain('do not stub');
  });
  it('does nothing for an existing module, one name, several targets or no check', async () => {
    const existing = workspace({ 'tests/mod.test.ts': TEST, 'src/mod.ts': 'export const a = 1;\n' });
    expect(await deriveExportSteps({ ...base, workspaceRoot: existing } as any)).toEqual([]);
    const one = workspace({ 'tests/mod.test.ts': `import { a } from '../src/mod.js';`, 'src/mod.ts': '' });
    expect(await deriveExportSteps({ ...base, workspaceRoot: one } as any)).toEqual([]);
    const empty = workspace({ 'tests/mod.test.ts': TEST });
    expect(await deriveExportSteps({ ...base, targetFiles: ['src/mod.ts', 'src/x.ts'], workspaceRoot: empty } as any)).toEqual([]);
    expect(await deriveExportSteps({ ...base, verifyCommand: undefined, workspaceRoot: empty } as any)).toEqual([]);
  });
});

import { runSteps } from '../src/tools/coding-agents/goal-steps.js';

describe('runSteps spec visibility', () => {
  it('runs the check only on the last step but hands earlier steps the same command as a read-only spec', async () => {
    const seen: Array<{ verifyCommand?: string; specCommand?: string }> = [];
    const ok = { applied: true, diagnostics: [] } as any;
    await runSteps({ goal: 'g', workspaceRoot: '.', verifyCommand: 'npx vitest run tests/a.test.ts' } as any, ['s1', 's2', 's3'], async step => {
      seen.push({ verifyCommand: step.verifyCommand, specCommand: step.specCommand });
      return ok;
    });
    expect(seen).toEqual([
      { verifyCommand: undefined, specCommand: 'npx vitest run tests/a.test.ts' },
      { verifyCommand: undefined, specCommand: 'npx vitest run tests/a.test.ts' },
      { verifyCommand: 'npx vitest run tests/a.test.ts', specCommand: undefined },
    ]);
  });
});

import { deriveHypotheses } from '../src/tools/coding-agents/hypothesis-gate.js';

describe('step goals and the hypothesis gate', () => {
  it('does not treat the names a step builds (or leaves to later steps) as things that must already exist', async () => {
    const root = workspace({ 'tests/mod.test.ts': "import { buildThing, readThing, openThing } from '../src/mod.js';\n", 'src/mod.ts': '' });
    const steps = await deriveExportSteps({ goal: 'Rebuild the module', verifyCommand: 'npx vitest run tests/mod.test.ts', targetFiles: ['src/mod.ts'], workspaceRoot: root } as any);
    expect(steps).toHaveLength(3);
    for (const goal of steps) {
      const probes = deriveHypotheses({ goal, files: ['src/other.ts'], targetFiles: ['src/mod.ts'] }).map(h => h.probe);
      expect(probes.filter(p => p.startsWith('defined:'))).toEqual([]);
    }
  });
});

import { exportsName, stepExportName, exportStepPreparer } from '../src/tools/coding-agents/export-steps.js';

describe('already-built exports', () => {
  it('detects ESM and CommonJS exports and nothing else', () => {
    expect(exportsName('export function foo() {}', 'foo')).toBe(true);
    expect(exportsName('export { a, foo as bar }', 'foo')).toBe(true);
    expect(exportsName('function foo() {}\nmodule.exports = { foo, bar };', 'foo')).toBe(true);
    expect(exportsName('exports.foo = () => 1;', 'foo')).toBe(true);
    expect(exportsName('function foo() {}', 'foo')).toBe(false);
    expect(exportsName('export function foobar() {}', 'foo')).toBe(false);
  });
  it('skips a step whose export exists, but turns an already-satisfied last step into a fix-the-check goal', async () => {
    const root = workspace({ 'tests/mod.test.ts': "import { buildThing, readThing } from '../src/mod.js';\n", 'src/mod.ts': '' });
    const input = { goal: 'Rebuild the module', verifyCommand: 'npx vitest run tests/mod.test.ts', targetFiles: ['src/mod.ts'], workspaceRoot: root } as any;
    const [s1, s2] = await deriveExportSteps(input);
    expect(stepExportName(s1)).toBe('buildThing');
    const prepare = exportStepPreparer(input);
    expect(await prepare(s1, false)).toBe(s1); // nothing built yet
    fs.writeFileSync(path.join(root, 'src/mod.ts'), 'export function buildThing() {}\nexport function readThing() {}\n');
    expect(await prepare(s1, false)).toBeNull();
    expect(await prepare(s2, true)).toContain('correct the existing code so the tests pass');
  });
});

import { newImportProblems } from '../src/tools/coding-agents/import-check.js';

describe('node: imports are checked, not waved through', () => {
  it('rejects node:sqlite3 but accepts node:sqlite, node:fs and node:test', async () => {
    const root = workspace({ 'src/a.js': '' });
    expect(await newImportProblems('src/a.js', '', 'const { DatabaseSync } = require("node:sqlite3");', root)).toEqual([expect.stringContaining("'node:sqlite3' is not a Node.js built-in module")]);
    expect(await newImportProblems('src/a.js', '', 'require("node:sqlite"); require("node:fs"); require("node:test"); require("node:fs/promises");', root)).toEqual([]);
  });
});
