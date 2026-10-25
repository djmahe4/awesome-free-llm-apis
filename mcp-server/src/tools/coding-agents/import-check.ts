import fs from 'fs-extra';
import path from 'node:path';
import { builtinModules } from 'node:module';

/**
 * Resolves the imports an edit ADDED against the real workspace. The in-memory TypeScript gate cannot see
 * the filesystem, so it ignores "cannot find module" (otherwise every correct import counted as an error);
 * this restores the check for real path mistakes, for JS/TS and Python, in milliseconds.
 * Returns one message per unresolved new import (empty when all resolve).
 */

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts', '.json'];
const BUILTINS = new Set(builtinModules);

function jsSpecifiers(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) out.add(m[1]);
  for (const m of src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.add(m[1]);
  for (const m of src.matchAll(/\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.add(m[1]);
  return [...out];
}

function pySpecifiers(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/^\s*from\s+(\.*[\w.]*)\s+import\b/gm)) out.add(m[1]);
  for (const m of src.matchAll(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm)) for (const n of m[1].split(',')) out.add(n.trim());
  return [...out];
}

async function exists(p: string): Promise<boolean> {
  return fs.pathExists(p);
}

async function resolveJsRelative(fromDir: string, spec: string): Promise<boolean> {
  const base = path.resolve(fromDir, spec);
  const stem = base.replace(/\.(m|c)?js$|\.jsx$/, '');
  const candidates = [base, ...JS_EXTS.map(e => stem + e), ...JS_EXTS.map(e => path.join(base, `index${e}`))];
  for (const c of candidates) if (await exists(c)) return true;
  return false;
}

async function jsPackageInstalled(fromDir: string, root: string, spec: string): Promise<boolean> {
  const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    if (await exists(path.join(dir, 'node_modules', name))) return true;
    if (dir === root || path.dirname(dir) === dir || !dir.startsWith(root)) break;
  }
  return exists(path.join(root, 'node_modules', name));
}

async function closestSibling(dir: string, wanted: string, transform: (f: string) => string): Promise<string | undefined> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  let best: { name: string; d: number } | undefined;
  for (const e of entries) {
    const name = transform(e);
    const d = editDistance(name.toLowerCase(), wanted.toLowerCase());
    if (d <= Math.max(2, Math.floor(wanted.length / 4)) && (!best || d < best.d)) best = { name, d };
  }
  return best?.name;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

async function pyModuleExists(root: string, fromDir: string, spec: string): Promise<{ ok: boolean; local: boolean; dir?: string; last?: string }> {
  const dots = spec.match(/^\.*/)![0].length;
  const parts = spec.slice(dots).split('.').filter(Boolean);
  let baseDir: string;
  if (dots > 0) {
    baseDir = fromDir;
    for (let i = 1; i < dots; i++) baseDir = path.dirname(baseDir);
  } else {
    // Only judge modules of a LOCAL package (its top-level directory exists in the workspace);
    // anything else may be installed in site-packages, which this check cannot see cheaply.
    if (!(await exists(path.join(root, parts[0]))) && !(await exists(path.join(root, `${parts[0]}.py`)))) return { ok: true, local: false };
    baseDir = root;
  }
  if (parts.length === 0) return { ok: true, local: true };
  const target = path.join(baseDir, ...parts);
  const ok = (await exists(`${target}.py`)) || (await exists(path.join(target, '__init__.py'))) || (await exists(target));
  return { ok, local: true, dir: path.dirname(target), last: parts[parts.length - 1] };
}

export async function newImportProblems(relPath: string, before: string, after: string, workspaceRoot: string): Promise<string[]> {
  const root = path.resolve(workspaceRoot);
  const abs = path.resolve(root, relPath);
  const fromDir = path.dirname(abs);
  const problems: string[] = [];

  if (/\.(m|c)?[jt]sx?$/i.test(relPath)) {
    const had = new Set(jsSpecifiers(before));
    for (const spec of jsSpecifiers(after).filter(s => !had.has(s))) {
      if (spec.startsWith('.') || spec.startsWith('/')) {
        if (!(await resolveJsRelative(fromDir, spec))) {
          const wantedBase = path.basename(spec).replace(/\.(m|c)?[jt]sx?$/, '');
          const near = await closestSibling(path.resolve(fromDir, path.dirname(spec)), wantedBase, f => f.replace(/\.(d\.)?(m|c)?[jt]sx?$/, ''));
          const ext = (spec.match(/\.(m|c)?[jt]sx?$/) ?? [''])[0];
          const dir = path.posix.dirname(spec.replace(/\\/g, '/'));
          const suggestion = near ? `${dir === '.' ? '.' : dir}/${near}${ext}` : '';
          problems.push(`${relPath}: import '${spec}' does not exist${near ? `; did you mean '${suggestion}'?` : ''}`);
        }
      } else {
        const bare = spec.replace(/^node:/, '');
        if (spec.startsWith('node:') || BUILTINS.has(bare) || BUILTINS.has(bare.split('/')[0])) continue;
        if (!(await jsPackageInstalled(fromDir, root, spec))) problems.push(`${relPath}: package '${spec.split('/')[0].startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]}' is not installed in this workspace`);
      }
    }
  } else if (/\.py$/i.test(relPath)) {
    const had = new Set(pySpecifiers(before));
    for (const spec of pySpecifiers(after).filter(s => !had.has(s))) {
      const r = await pyModuleExists(root, fromDir, spec);
      if (r.ok) continue;
      const near = r.dir && r.last ? await closestSibling(r.dir, r.last, f => f.replace(/\.py$/, '')) : undefined;
      const prefix = spec.includes('.') ? spec.slice(0, spec.lastIndexOf('.') + 1) : '';
      problems.push(`${relPath}: module '${spec}' does not exist${near ? `; did you mean '${prefix}${near}'?` : ''}`);
    }
  }
  return problems;
}
