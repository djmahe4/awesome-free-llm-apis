import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findByBasename, newImportProblems } from '../src/tools/coding-agents/import-check.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function ws(files: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-suggest-'));
  dirs.push(dir);
  for (const rel of files) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), ''); }
  return dir;
}
const problem = async (root: string, from: string, spec: string) => (await newImportProblems(from, '', `import { x } from '${spec}';`, root))[0];

describe('import suggestions find the file by name, wherever it is', () => {
  it('turns a wrong parent-relative path into the sibling path', async () => {
    const root = ws(['src/harness/thought-dag.ts', 'src/harness/zed.ts']);
    expect(await problem(root, 'src/harness/zed.ts', '../thought-dag.js')).toContain("did you mean './thought-dag.js'?");
  });
  it('turns a workspace-rooted path written from the wrong folder into the real relative path', async () => {
    const root = ws(['src/harness/thought-dag.ts', 'src/tools/a.ts']);
    expect(await problem(root, 'src/tools/a.ts', '../src/harness/thought-dag.js')).toContain("did you mean '../harness/thought-dag.js'?");
  });
  it('keeps the extension style of the bad import and picks the closest of several matches', async () => {
    const root = ws(['src/a/util.ts', 'src/a/b/c/util.ts', 'src/a/b/user.ts']);
    expect(await findByBasename(root, 'util', path.join(root, 'src/a/b'), '.js')).toBe('../util.js');
    expect(await findByBasename(root, 'util', path.join(root, 'src/a/b'), '.mjs')).toBe('../util.mjs');
  });
  it('falls back to the fuzzy sibling, and says nothing when nothing resembles the name', async () => {
    const root = ws(['src/check.ts', 'src/run.ts']);
    expect(await problem(root, 'src/run.ts', './chek.js')).toContain("did you mean './check.js'?");
    expect(await problem(root, 'src/run.ts', './zzzzqqqq.js')).not.toContain('did you mean');
  });
  it('ignores node_modules and declaration files', async () => {
    const root = ws(['node_modules/pkg/thing.ts', 'src/types.d.ts', 'src/run.ts']);
    expect(await findByBasename(root, 'thing', path.join(root, 'src'), '.js')).toBeUndefined();
    expect(await findByBasename(root, 'types', path.join(root, 'src'), '.js')).toBeUndefined();
  });
});
