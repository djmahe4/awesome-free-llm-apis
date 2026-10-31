/**
 * Rerank grep candidates by how specifically they match the goal, before the file cap is applied.
 *
 * Without this, files with the same path priority were ordered alphabetically, so thirty files sharing the goal's
 * everyday words (apply, order, total) could push out the one file that contained its distinctive name. A term that
 * appears in most candidate files tells us little; a term that appears in one tells us a lot (inverse document
 * frequency, as in retrieve-wide-then-rerank pipelines such as RankRAG 2407.02485). Needs no model.
 *
 * CONTEXT_RERANK: on (default) | off (restores the previous order).
 */

export interface FileLines {
  file: string;
  lines: Array<{ line: number; content: string }>;
}

export function rerankEnabled(): boolean {
  return (process.env.CONTEXT_RERANK ?? 'on').toLowerCase() !== 'off';
}

/** Score per file: sum over the goal terms it contains of log(1 + N / documentFrequency), plus a bonus for a term in its path. */
export function scoreFiles(entries: FileLines[], terms: string[]): Map<string, number> {
  const scores = new Map<string, number>();
  const usable = [...new Set(terms.map(t => t.trim().toLowerCase()).filter(t => t.length > 2))];
  if (entries.length === 0 || usable.length === 0) return scores;

  const present = entries.map(e => {
    const text = e.lines.map(l => l.content).join('\n').toLowerCase();
    const filePath = e.file.toLowerCase();
    return { inText: new Set(usable.filter(t => text.includes(t))), inPath: new Set(usable.filter(t => filePath.includes(t))) };
  });
  const df = new Map<string, number>();
  for (const p of present) for (const t of new Set([...p.inText, ...p.inPath])) df.set(t, (df.get(t) ?? 0) + 1);

  entries.forEach((e, i) => {
    let s = 0;
    for (const t of new Set([...present[i].inText, ...present[i].inPath])) {
      const weight = Math.log(1 + entries.length / (df.get(t) ?? 1));
      s += weight * (present[i].inPath.has(t) ? 2 : 1);
    }
    scores.set(e.file, s);
  });
  return scores;
}

/**
 * Orders files best first. `tier` is the existing path priority (an explicitly named file is tier 0 and always stays
 * first); within the remaining files the score decides and the old tier and name only break ties.
 */
export function rerankFiles(entries: FileLines[], terms: string[], tier: (file: string) => number): string[] {
  const scores = scoreFiles(entries, terms);
  return entries.map(e => e.file).sort((a, b) => {
    const ta = tier(a), tb = tier(b);
    if ((ta === 0) !== (tb === 0)) return ta === 0 ? -1 : 1;
    const sa = scores.get(a) ?? 0, sb = scores.get(b) ?? 0;
    if (Math.abs(sa - sb) > 1e-9) return sb - sa;
    if (ta !== tb) return ta - tb;
    return a.localeCompare(b);
  });
}
