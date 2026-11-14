import fs from 'node:fs/promises';
import path from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * A per-project record of how runs failed (#149). Keys come from facts, not model wording. A later run on the same
 * file starts with the matching remediation, so it does not repeat a known mistake.
 */

export type MistakeKind = 'symbol_loss' | 'cycling' | 'timed_out' | 'stuck' | 'not_converged';

export interface Mistake {
  kind: MistakeKind;
  file: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  remediation: string;
}

const MAX_AGE_MS = 30 * 86_400_000;
const MAX_LINES = 3;

const REMEDIATION: Record<MistakeKind, string> = {
  symbol_loss: 'An earlier edit of this file removed a declaration. Keep every existing declaration; insert next to it, do not replace it.',
  cycling: 'Earlier edits of this file went back and forth between the same failures. Change one thing and keep what already passes.',
  timed_out: 'An earlier edit of this file ran out of time. Keep the edit small: one location at a time.',
  stuck: 'An earlier edit of this file repeated the same failure. Try a different approach instead of the same change.',
  not_converged: 'An earlier edit of this file never passed its check. Read the failing test before editing.',
};

const storePath = (root: string) => path.join(root, '.free-llm-mcp', 'mistakes.json');

/** The kind of failure a run ended with; undefined for a run that finished or was stopped on purpose. */
export function classifyMistake(run: { outcome?: string; symbolLoss?: string[] }): MistakeKind | undefined {
  if (run.outcome === 'converged' || run.outcome === 'unverified' || run.outcome === 'aborted' || run.outcome === 'needs_user' || run.outcome === undefined) return undefined;
  if (run.symbolLoss?.length) return 'symbol_loss';
  return run.outcome === 'cycling' || run.outcome === 'timed_out' || run.outcome === 'stuck' ? run.outcome : 'not_converged';
}

/** The stored mistakes; a missing or corrupt file reads as empty. */
export async function loadMistakes(root: string): Promise<Mistake[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(storePath(root), 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Adds one to the count for this kind on each file, creating the entry when it is new. */
export async function recordMistake(root: string, kind: MistakeKind, files: string[], now = Date.now()): Promise<void> {
  const store = await loadMistakes(root);
  for (const file of files) {
    const entry = store.find(m => m.kind === kind && m.file === file);
    if (entry) { entry.count++; entry.lastSeen = now; }
    else store.push({ kind, file, count: 1, firstSeen: now, lastSeen: now, remediation: REMEDIATION[kind] });
  }
  await fs.mkdir(path.dirname(storePath(root)), { recursive: true });
  await fs.writeFile(storePath(root), JSON.stringify(store, null, 2), 'utf-8');
}

/** The remediations for these files seen in the last thirty days: once each, most frequent first, at most three. */
export async function remediationsFor(root: string, files: string[], now = Date.now()): Promise<string[]> {
  const fresh = (await loadMistakes(root)).filter(m => files.includes(m.file) && now - m.lastSeen < MAX_AGE_MS);
  fresh.sort((a, b) => b.count - a.count);
  return [...new Set(fresh.map(m => m.remediation))].slice(0, MAX_LINES);
}

/**
 * The failing fact behind a run that did not converge: the first runtime error or assertion line of the check's output
 * plus the line of the test that raised it. `kind` says THAT a run failed; this says WHAT failed ("messages is not
 * iterable" when called as `buildThing('s1', 'x', { messages: [...] })`), which is what a retry can act on.
 */
export function failureFact(outputTail: string | undefined, root: string): string | undefined {
  if (!outputTail) return undefined;
  const lines = outputTail.split(/\r?\n/);
  const msg = lines.map(l => l.trim()).find(l => /\b(?:TypeError|ReferenceError|RangeError|SyntaxError|AssertionError)\b/.test(l));
  if (!msg) return undefined;
  const clean = (s: string) => s.replace(/\s+/g, ' ').slice(0, 200);
  const frame = lines.map(l => l.match(/([\w./\\:-]*(?:tests?|__tests__)[\\/][\w./\\-]+\.(?:[cm]?[jt]sx?)):(\d+)(?::\d+)?/)).find(Boolean);
  if (frame) {
    try {
      const abs = path.resolve(root, frame[1].replace(/^.*?(?=(?:tests?|__tests__)[\\/])/, ''));
      const src = readFileSync(abs, 'utf8').split(/\r?\n/)[Number(frame[2]) - 1];
      if (src?.trim()) return clean(`${msg} — raised at ${path.relative(root, abs).replace(/\\/g, '/')}:${frame[2]}: ${src.trim()}`);
    } catch { /* the message alone still helps */ }
  }
  return clean(msg);
}

const MAX_FACTS = 2;
const factStorePath = (root: string) => path.join(root, '.free-llm-mcp', 'failure-facts.json');

interface FailureFact { file: string; fact: string; lastSeen: number }

async function loadFacts(root: string): Promise<FailureFact[]> {
  try { const p = JSON.parse(await fs.readFile(factStorePath(root), 'utf-8')); return Array.isArray(p) ? p : []; } catch { return []; }
}

/** Remembers one failing fact for each of these files (the newest replaces an identical older one). */
export async function recordFailureFact(root: string, files: string[], fact: string, now = Date.now()): Promise<void> {
  const store = (await loadFacts(root)).filter(f => !(files.includes(f.file) && f.fact === fact));
  for (const file of files) store.push({ file, fact, lastSeen: now });
  await fs.mkdir(path.dirname(factStorePath(root)), { recursive: true });
  await fs.writeFile(factStorePath(root), JSON.stringify(store.slice(-50), null, 2), 'utf-8');
}

/** The newest facts for these files from the last thirty days, phrased for the next attempt's feedback. */
export async function failureFactsFor(root: string, files: string[], now = Date.now()): Promise<string[]> {
  return (await loadFacts(root))
    .filter(f => files.includes(f.file) && now - f.lastSeen < MAX_AGE_MS)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, MAX_FACTS)
    .map(f => `A previous run on ${f.file} failed with: ${f.fact}`);
}
