/**
 * Test hygiene: a test that creates files or folders in the OS temp directory must remove them again.
 * Leaked temp folders pile up on developer machines and CI runners, and a removal that is attempted once
 * races with background writers (ENOTEMPTY on Windows), so removal should go through tests/helpers/temp-dir.ts
 * or pass maxRetries.
 */

const CREATES_TEMP = /\bmkdtemp(Sync)?\(|\btmpdir\(\)/;
const WRITES = /\b(writeFile|writeFileSync|appendFile|mkdir|mkdirSync|ensureDir|ensureDirSync|outputFile|outputFileSync|copyFile|copy|mkdtemp|mkdtempSync)\(/;
const REMOVES = /\b(rm|rmSync|remove|removeSync|rmdir|rmdirSync|unlink|unlinkSync|removeDir|rimraf)\(/;

export interface HygieneProblem { file: string; problem: string }

export function findTempHygieneProblems(files: { path: string; content: string }[]): HygieneProblem[] {
  const out: HygieneProblem[] = [];
  for (const f of files) {
    if (f.path.split('\\').join('/').includes('/helpers/')) continue;
    if (!CREATES_TEMP.test(f.content) || !WRITES.test(f.content)) continue;
    if (!REMOVES.test(f.content)) out.push({ file: f.path, problem: 'creates files in the temp directory but never removes them (add an afterAll/afterEach with removeDir from tests/helpers/temp-dir.ts)' });
  }
  return out;
}

/** Removals that are tried once, with no retries and not via removeDir, in a file that makes temp dirs. */
export function findRetrylessRemovals(files: { path: string; content: string }[]): HygieneProblem[] {
  const out: HygieneProblem[] = [];
  for (const f of files) {
    if (!/\bmkdtemp(Sync)?\(/.test(f.content)) continue;
    const lines = f.content.split(/\r?\n/);
    lines.forEach((rawLine, i) => {
      // a removal named inside a string (test data) is not a removal
      const line = rawLine.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
      if (/\.(rm|rmSync|remove|removeSync)\(/.test(line) && !/maxRetries|removeDir|\{\s*force:\s*true\s*\}/.test(line) && /recursive|remove\(/.test(line)) {
        out.push({ file: `${f.path}:${i + 1}`, problem: 'single-attempt directory removal; use removeDir() or pass maxRetries' });
      }
    });
  }
  return out;
}
