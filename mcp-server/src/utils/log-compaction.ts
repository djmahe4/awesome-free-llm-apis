/**
 * Shared log/JSON line compaction, extracted from ContextGatherer so the same behaviour serves both
 * the grep-context path and test-failure briefs: near-duplicate lines (differing only in numbers,
 * ids, timestamps) collapse into one representative plus a count.
 */

/**
 * Jaccard similarity of two lines after replacing every token that contains a digit with `#`, so
 * "request 4312 took 18ms" and "request 4313 took 21ms" count as the same shape.
 * Markdown headers and lines the caller wants preserved (`preserve`, e.g. embedded code fields)
 * never match anything.
 */
export function jaccardSimilarity(s1: string, s2: string, preserve?: (s: string) => boolean): number {
  if (s1.trim().startsWith('#') || s2.trim().startsWith('#')) return 0;
  if (preserve && (preserve(s1) || preserve(s2))) return 0;
  const norm = (s: string) => s.replace(/[a-zA-Z0-9]*\d+[a-zA-Z0-9]*/g, '#');
  const tokenize = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9_#]+/g) || []);
  const a = tokenize(norm(s1));
  const b = tokenize(norm(s2));
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = [...a].filter(x => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return intersection / union;
}

export interface CompactOptions {
  /** Similarity at or above which neighbouring lines collapse (LOG_COMPACTION_THRESHOLD default 0.82). */
  threshold?: number;
  /** Lines kept verbatim at each end. */
  head?: number;
  tail?: number;
  /** Longer lines are cut to this many characters. */
  maxLineChars?: number;
  preserve?: (s: string) => boolean;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}... (truncated)` : s);

/**
 * Keeps the first `head` and last `tail` lines, and collapses runs of near-duplicate lines in the
 * middle to the first line of the run plus a "(N similar lines collapsed)" marker.
 */
export function collapseSimilarLines(lines: string[], opts: CompactOptions = {}): string[] {
  const threshold = opts.threshold ?? (parseFloat(process.env.LOG_COMPACTION_THRESHOLD || '') || 0.82);
  const head = opts.head ?? 3;
  const tail = opts.tail ?? 3;
  const max = opts.maxLineChars ?? 400;
  if (lines.length <= head + tail) return lines.map(l => clip(l, max));

  const out: string[] = lines.slice(0, head).map(l => clip(l, max));
  const middle = lines.slice(head, lines.length - tail);
  let i = 0;
  while (i < middle.length) {
    let j = i + 1;
    while (j < middle.length && jaccardSimilarity(middle[i], middle[j], opts.preserve) >= threshold) j++;
    if (j - i > 1) out.push(`.. (${j - i} similar lines collapsed)`);
    out.push(clip(middle[i], max));
    i = j;
  }
  out.push(...lines.slice(lines.length - tail).map(l => clip(l, max)));
  return out;
}
