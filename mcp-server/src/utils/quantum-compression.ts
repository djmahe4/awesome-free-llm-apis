/**
 * Lightweight local (non-LLM) text compressor for quantum_tool's 'analyze'
 * prompt — keeps the branch-state + evidence prompt from growing unbounded
 * across many circuit steps without needing a summarization round-trip.
 *
 * "Symbol density" = ratio of unique meaningful tokens to sentence length;
 * a low-density sentence ("um, so basically, I think that...") carries less
 * information per word than a high-density one ("Confidence rose from 0.3 to
 * 0.8 after the RY(1.2) rotation"), so it's the first to go under a tighter
 * `temperature` budget.
 */

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'for', 'with', 'that', 'this', 'it', 'as', 'at', 'by',
  'so', 'basically', 'just', 'really', 'i', 'think', 'um', 'like',
]);

function splitSentences(text: string): string[] {
  const rawSegments = text.split(/\r?\n+/).map(s => s.trim()).filter(Boolean);
  const result: string[] = [];
  for (const seg of rawSegments) {
    // Keep headers, list items (numbered or bulleted), and code fences intact as atomic sentences
    if (/^(?:#+|-|\*|\d+\.)\s+/.test(seg) || seg.startsWith('```')) {
      result.push(seg);
      continue;
    }
    // For prose, split on sentence boundary where preceding char is not a single list digit
    const sentences = seg.split(/(?<=[a-zA-Z0-9)\]"'][.!?])\s+(?=[A-Z0-9"']|$)/).map(s => s.trim()).filter(Boolean);
    if (sentences.length > 0) {
      result.push(...sentences);
    } else {
      result.push(seg);
    }
  }
  return result;
}

function symbolDensity(sentence: string): number {
  const tokens = sentence.toLowerCase().match(/[a-z0-9_\-\.\/:]+/g) || [];
  if (tokens.length === 0) return 0;
  let meaningful = 0;
  for (const t of tokens) {
    if (!STOP_WORDS.has(t)) {
      meaningful++;
      // High-signal indicators: paths, numbers, code identifiers, ports
      if (/[0-9_\-\.\/:]/.test(t)) {
        meaningful += 0.5;
      }
    }
  }
  return meaningful / tokens.length;
}

/**
 * Keeps the top `temperature` fraction (0..1) of sentences by symbol density,
 * always preserving the first and last sentence for context continuity.
 * temperature=1 returns the text unchanged; temperature=0 keeps only the
 * first/last sentence.
 * Optional `focusTokens` steers retention towards query-relevant sentences.
 */
export function quantumCompress(
  text: string,
  temperature = 0.5,
  focusTokens?: Set<string> | string[]
): string {
  const clamped = Math.max(0, Math.min(1, temperature));
  if (clamped >= 1) return text;

  const sentences = splitSentences(text);
  if (sentences.length <= 2) return text;

  const focusSet = focusTokens
    ? (focusTokens instanceof Set ? focusTokens : new Set(focusTokens.map(f => f.toLowerCase())))
    : null;

  const scored = sentences.map((s, i) => {
    let density = symbolDensity(s);
    if (focusSet && focusSet.size > 0) {
      const lower = s.toLowerCase();
      let matchCount = 0;
      focusSet.forEach(t => {
        if (t && lower.includes(t)) matchCount++;
      });
      if (matchCount > 0) {
        density += matchCount * 1.5;
      }
    }
    return { s, i, density };
  });

  const keepCount = Math.max(2, Math.round(sentences.length * clamped));

  const first = scored[0];
  const last = scored[scored.length - 1];
  const middle = scored.slice(1, -1).sort((a, b) => b.density - a.density);
  const keptMiddle = middle.slice(0, Math.max(0, keepCount - 2));

  const kept = [first, ...keptMiddle, last]
    .filter((v, idx, arr) => arr.findIndex(x => x.i === v.i) === idx)
    .sort((a, b) => a.i - b.i);

  const hasNewlines = text.includes('\n');
  return kept.map(k => k.s).join(hasNewlines ? '\n' : ' ');
}

export interface QuantumCompressionStats {
  compressedText: string;
  rawLength: number;
  compressedLength: number;
  rawTokensEstimate: number;
  compressedTokensEstimate: number;
  compressionRatio: number;
  symbolDensity: number;
}

/**
 * Compresses text and computes detailed token metrics and symbol density statistics.
 */
export function quantumCompressWithStats(
  text: string,
  temperature = 0.5,
  focusTokens?: Set<string> | string[]
): QuantumCompressionStats {
  const rawLength = text.length;
  const rawTokensEstimate = Math.ceil(rawLength / 3.8);
  const sentences = splitSentences(text);
  const avgDensity = sentences.length > 0
    ? sentences.reduce((sum, s) => sum + symbolDensity(s), 0) / sentences.length
    : 0;

  const compressedText = quantumCompress(text, temperature, focusTokens);
  const compressedLength = compressedText.length;
  const compressedTokensEstimate = Math.ceil(compressedLength / 3.8);
  const compressionRatio = rawLength > 0 ? Math.max(0, (rawLength - compressedLength) / rawLength) : 0;

  return {
    compressedText,
    rawLength,
    compressedLength,
    rawTokensEstimate,
    compressedTokensEstimate,
    compressionRatio,
    symbolDensity: Math.round(avgDensity * 1000) / 1000,
  };
}
