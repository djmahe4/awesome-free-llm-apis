import fs from 'node:fs/promises';
import path from 'node:path';

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
