import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runVerifyCommand, type VerifyRunResult } from './verify-command.js';
import { commandTargets } from './verify-guard.js';

/**
 * The verifyCommand result for a given state of the files, reused within one repair-loop run (issue #108).
 *
 * Each attempt runs the check before the edit (the baseline) and after it. The baseline of attempt N is the
 * same tree as the after-check of attempt N-1 when that edit was kept, and the original tree when it was
 * rolled back, so most baselines were re-running tests on code that had just been tested. The key is the
 * command plus the content of the edited files and of the test files the command names; anything else the
 * tests read is assumed unchanged during a run, which is why the cache is cleared when a run starts.
 */

type Runner = (command: string, cwd: string) => Promise<VerifyRunResult>;

const cache = new Map<string, VerifyRunResult>();
const MAX_ENTRIES = 32;

export function resetVerifyCache(): void {
  cache.clear();
}

async function stateKey(command: string, workspaceRoot: string, files: string[]): Promise<string> {
  const h = crypto.createHash('sha256').update(command).update('\0').update(path.resolve(workspaceRoot));
  const all = [...new Set([...files, ...commandTargets(command)].map(f => f.replace(/\\/g, '/')))].sort();
  for (const f of all) {
    let content = '<missing>';
    try { content = await fs.readFile(path.resolve(workspaceRoot, f), 'utf-8'); } catch { /* a file that does not exist yet is part of the state too */ }
    h.update('\0').update(f).update('\0').update(content);
  }
  return h.digest('hex');
}

/** Runs the check, or returns the result recorded for exactly this state of the files. Timed-out runs are not kept. */
export async function cachedVerify(command: string, workspaceRoot: string, files: string[], run: Runner = runVerifyCommand): Promise<VerifyRunResult & { cached?: boolean }> {
  const key = await stateKey(command, workspaceRoot, files);
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };
  const result = await run(command, workspaceRoot);
  if (!result.timedOut && !result.rejected) {
    cache.set(key, result);
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  }
  return result;
}
