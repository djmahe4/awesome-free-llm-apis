import path from 'node:path';
import { localLlmPatch } from '../local-llm-patch.js';
import { type DiagnosticResult } from './types.js';
import { runTsMorphCheck } from './diagnostics.js';
import { extractCodeBlock } from './tasks.js';

// Large enough that one declaration of the named symbol beats a dense run of plain mentions
// (a 13-line neighborhood of mentions weighs about 5 x 13 = 65).
const DECLARATION_BONUS = 100;

export function extractWindowForInstruction(
  content: string,
  instruction: string,
  windowSize = 120
): { window: string; startIdx: number; endIdx: number; lineCount: number } | null {
  const lines = content.split(/\r?\n/);
  if (lines.length <= windowSize) return null;

  const rawTerms = instruction.match(/\b[a-zA-Z][a-zA-Z0-9_-]{4,}\b/g) ?? [];
  // An identifier-looking term (camelCase, PascalCase, snake_case) names a symbol; plain words
  // like "method" or "change" occur everywhere and must not outvote it.
  const isIdentifier = (t: string) => /[a-z][A-Z]|^[A-Z][a-z]+[A-Z]|_/.test(t);
  const seen = new Set<string>();
  const weighted: Array<{ term: string; weight: number; ident: boolean }> = [];
  for (const raw of rawTerms) {
    const term = raw.toLowerCase();
    if (seen.has(term)) continue;
    seen.add(term);
    const ident = isIdentifier(raw);
    weighted.push({ term, weight: ident ? 4 : 1, ident });
  }
  const uniqueTerms = weighted.slice(0, 12);
  const declRe = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:class|function|interface|type|enum|def|const|let|struct|fn)\b/;

  const perLineScore = lines.map(line => {
    const lower = line.toLowerCase();
    let score = 0;
    for (const { term, weight, ident } of uniqueTerms) {
      if (!lower.includes(term)) continue;
      score += weight;
      // The line that DECLARES the named symbol is where the edit belongs.
      if (ident && declRe.test(line)) score += DECLARATION_BONUS;
    }
    return score;
  });

  // A single keyword-dense line (e.g. one ternary chaining status/complete/
  // failed) can outscore the real target whose matching terms are spread
  // across several lines of a multi-line block — sum scores over a local
  // neighborhood instead of picking the single highest-scoring line, so
  // sustained relevance beats one coincidentally dense outlier line.
  // Observed live: this picked a 120-line window around an unrelated
  // one-liner in finalizeRun instead of the real multi-line target in
  // applyResearchResult, and the model then hallucinated an edit to the only
  // thing it could see — applied cleanly (real text, no TS regression),
  // reported success, and silently missed the actual requested change.
  const neighborhood = 6;
  let bestScore = 0;
  let bestLine = -1;
  for (let i = 0; i < lines.length; i++) {
    let windowScore = 0;
    for (let j = Math.max(0, i - neighborhood); j <= Math.min(lines.length - 1, i + neighborhood); j++) {
      windowScore += perLineScore[j];
    }
    if (windowScore > bestScore) { bestScore = windowScore; bestLine = i; }
  }

  // Nothing in the file matches (typical for "add X": X does not exist yet). The old code then
  // kept the first zero-score line, i.e. the file HEAD, which is the wrong place to add code.
  // New code goes after the module's last top-level declaration, so anchor there.
  if (bestLine < 0) {
    let lastDecl = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:class|function|interface|type|enum|def|struct|fn)\b/.test(lines[i])) { lastDecl = i; break; }
    }
    bestLine = lastDecl >= 0 ? lastDecl : lines.length - 1;
  }

  const half = Math.floor(windowSize / 2);
  const startIdx = Math.max(0, bestLine - half);
  const endIdx = Math.min(lines.length, bestLine + half);
  return { window: lines.slice(startIdx, endIdx).join('\n'), startIdx, endIdx, lineCount: lines.length };
}

/**
 * Corruption guard for LLM-generated full-file replacements on EXISTING files.
 * ContextGatherer.gatherContext (used by localLlmPatch for prompt enrichment)
 * has a known relevance-ranking gap — "top N files" isn't "N most relevant
 * files" — so a weak local model can occasionally latch onto irrelevant
 * injected context and produce a syntactically valid, but completely
 * unrelated, full-file replacement (observed live: a real 364-line
 * MemoryManager class replaced wholesale with an unrelated smoke-test
 * script). LSP/syntax diagnostics don't catch this — the output is valid
 * code, just the wrong code. This is a content-level backstop: for a
 * non-trivial existing file, at least one of its own top-level declared
 * symbols (class/function/interface/const/type) must still appear
 * *somewhere* in the replacement, or it's treated as a hallucinated
 * replacement rather than a real edit.
 */
/**
 * Sliding-window fidelity guard: a model can honor "don't touch anything
 * outside the excerpt" while still mangling the excerpt itself in ways a
 * mere line-count check misses — observed live, twice, on the same 120-line
 * window: once collapsed down to ~2 lines, once kept a near-identical total
 * line count but with rows duplicated near the boundary and the actual
 * target line silently dropped in the shuffle. Because the loss/shift is
 * small relative to the WHOLE file, looksLikeHallucinatedReplacement's
 * overlap check on the spliced full content doesn't catch either case.
 * This compares the window in isolation via multiset line overlap: a real
 * targeted edit changes a line or two and reproduces everything else
 * byte-for-byte, so overlap should be near-total regardless of whether the
 * counts happen to match.
 */
export function windowReplyIsSuspicious(originalWindowLines: string[], replyLines: string[]): boolean {
  if (originalWindowLines.length < 5) return false;
  const available = new Map<string, number>();
  for (const line of originalWindowLines) available.set(line, (available.get(line) || 0) + 1);
  let kept = 0;
  for (const line of replyLines) {
    const remaining = available.get(line) || 0;
    if (remaining > 0) {
      available.set(line, remaining - 1);
      kept++;
    }
  }
  return kept / originalWindowLines.length < 0.85;
}

/**
 * SEARCH/REPLACE block patching (Aider-style) — the actual fix for the
 * class of failure the window-fidelity guard above can only detect, not
 * prevent: every prior strategy (full-file, sliding window) asks the model
 * to REPRODUCE unchanged text, and weak local models fail at verbatim copy
 * even over a 120-line excerpt (observed: collapsed excerpts, duplicated/
 * dropped rows). This asks for zero reproduction — the model emits only the
 * exact text to find and its replacement; unchanged content never passes
 * through the model at all, so collapse/duplication/ellipsis-elision are
 * structurally impossible, not just caught after the fact.
 */
interface SearchReplaceBlock { search: string; replace: string }

export function parseSearchReplaceBlocks(text: string): SearchReplaceBlock[] {
  return parseSearchReplaceBlocksDetailed(text).blocks;
}

/**
 * Like parseSearchReplaceBlocks, but also reports a block that was started and never
 * closed with a REPLACE marker (typically a reply cut off at the output limit). Such a
 * block is not applied, but callers must be able to tell it was lost.
 */
export function parseSearchReplaceBlocksDetailed(text: string): { blocks: SearchReplaceBlock[]; incomplete: number } {
  const blocks: SearchReplaceBlock[] = [];
  const lines = text.replace(/([^\s=])(={5,})[ \t]*$/gm, (_m, a, b) => a + String.fromCharCode(10) + b).replace(/([^\s>])(>{5,}[ \t]*(?:REPLACE)?)[ \t]*$/gim, (_m, a, b) => a + String.fromCharCode(10) + b).split(/\r?\n/);
  let state: 'OUTSIDE' | 'IN_SEARCH' | 'IN_REPLACE' = 'OUTSIDE';
  let curSearch: string[] = [];
  let curReplace: string[] = [];

  const isSearchMarker = (l: string) => /^<{5,}\s*SEARCH\s*$/i.test(l.trim());
  const isDividerMarker = (l: string) => /^={5,}\s*$/i.test(l.trim());
  // A bare ">>>>>>>" closes a block too, and so does a second "=======": qwen2.5-coder:7b writes the
  // latter, and rejecting that reply cost a 126 s whole-file regeneration per attempt (traced live).
  const isReplaceMarker = (l: string) => /^>{5,}\s*(REPLACE)?\s*$/i.test(l.trim()) || isDividerMarker(l);

  for (const line of lines) {
    if (state === 'OUTSIDE') {
      if (isSearchMarker(line)) {
        state = 'IN_SEARCH';
        curSearch = [];
        curReplace = [];
      }
    } else if (state === 'IN_SEARCH') {
      if (isDividerMarker(line)) {
        state = 'IN_REPLACE';
      } else if (isSearchMarker(line)) {
        // Reset if another search marker begins without divider
        curSearch = [];
        curReplace = [];
      } else {
        curSearch.push(line);
      }
    } else if (state === 'IN_REPLACE') {
      if (isReplaceMarker(line)) {
        blocks.push({
          search: curSearch.join('\n'),
          replace: curReplace.join('\n'),
        });
        state = 'OUTSIDE';
        curSearch = [];
        curReplace = [];
      } else if (isSearchMarker(line)) {
        // Premature new block started
        state = 'IN_SEARCH';
        curSearch = [];
        curReplace = [];
      } else {
        curReplace.push(line);
      }
    }
  }

  return { blocks, incomplete: state === 'OUTSIDE' ? 0 : 1 };
}

/** "// Add this import", "// Insert this line": the model annotating its own edit, never wanted in the file. */
const EDIT_ECHO_COMMENT = /\s+\/\/\s*(add|added|insert|inserted|new|change|changed|update|updated)\s+(this|here|the)\b.*$/i;
/** Edits closer than this many unchanged lines are merged into one block, so their contexts never overlap. */
const MERGE_GAP = 4;

/**
 * Asked for SEARCH/REPLACE, a small model often returns the whole edited excerpt in a code fence instead
 * (traced live with qwen2.5-coder:7b). The edit inside is frequently right, so recover it: diff the
 * excerpt against the original and emit one block per changed hunk. SEARCH comes from the ORIGINAL with
 * a little context, so lines the model copied wrongly outside a hunk can never reach the file.
 * Deletion-only hunks at the very start or end are the model dropping the excerpt's edge lines and are
 * ignored. A copy that shares under 60% of the original's lines is a rewrite, not an edit: nothing.
 */
export function editsFromRewrittenExcerpt(original: string, reply: string): { blocks: SearchReplaceBlock[] } {
  const none = { blocks: [] as SearchReplaceBlock[] };
  if (/^<{5,}\s*SEARCH/m.test(reply)) return none;
  const fenced = reply.match(/```[\w+-]*\r?\n([\s\S]*?)\r?\n```/);
  if (!fenced) return none;
  const a = original.split(/\r?\n/);
  const b = fenced[1].split(/\r?\n/).map(l => l.replace(EDIT_ECHO_COMMENT, ''));
  const n = a.length, m = b.length;
  if (n === 0 || m === 0 || n * m > 4_000_000) return none;

  // Longest common subsequence over lines (excerpts are ~150 lines, so the table is small).
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  if (dp[0] < n * 0.6) return none;

  type Hunk = { start: number; end: number; ins: string[] }; // replaces a[start, end) with ins
  const hunks: Hunk[] = [];
  let i = 0, j = 0, cur: Hunk | null = null;
  const flush = () => { if (cur) { hunks.push(cur); cur = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); i++; j++; continue; }
    if (!cur) cur = { start: i, end: i, ins: [] };
    if (j < m && (i >= n || dp[i * w + j + 1] >= dp[(i + 1) * w + j])) { cur.ins.push(b[j]); j++; }
    else { i++; cur.end = i; }
  }
  flush();

  // Lines missing at the excerpt's edges were dropped by the copy, not deleted on purpose: keep them,
  // also when the dropped edge shares a hunk with a real change next to it.
  for (const h of hunks) {
    // Only the excess: a hunk that replaces k lines with fewer has dropped the rest at the edge.
    if (h.end === n) while (h.end - h.start > h.ins.length) h.end--;
    if (h.start === 0) while (h.end - h.start > h.ins.length) h.start++;
  }
  const kept = hunks.filter(h => !(h.ins.length === 0 && h.start === h.end));
  // Merge hunks separated by only a few unchanged lines.
  const merged: Hunk[] = [];
  for (const h of kept) {
    const prev = merged[merged.length - 1];
    if (prev && h.start - prev.end < MERGE_GAP) {
      prev.ins = [...prev.ins, ...a.slice(prev.end, h.start), ...h.ins];
      prev.end = h.end;
    } else merged.push({ ...h, ins: [...h.ins] });
  }

  const occurrences = (needle: string[]) => {
    let count = 0;
    for (let s = 0; s + needle.length <= n; s++) {
      let ok = true;
      for (let t = 0; t < needle.length; t++) if (a[s + t] !== needle[t]) { ok = false; break; }
      if (ok && ++count > 1) break;
    }
    return count;
  };

  const blocks: SearchReplaceBlock[] = [];
  for (const h of merged) {
    // Grow context until the SEARCH text is unique in the original (and never empty).
    for (let ctx = 1; ctx <= 6; ctx++) {
      const before = a.slice(Math.max(0, h.start - ctx), h.start);
      const after = a.slice(h.end, Math.min(n, h.end + ctx));
      const search = [...before, ...a.slice(h.start, h.end), ...after];
      if (search.join('').trim() === '') continue;
      if (occurrences(search) === 1 || ctx === 6) {
        blocks.push({ search: search.join('\n'), replace: [...before, ...h.ins, ...after].join('\n') });
        break;
      }
    }
  }
  return { blocks };
}

/**
 * Applies blocks via exact substring match — each SEARCH text must occur
 * exactly once in the current content (0 matches = anchor drifted/model
 * misquoted; >1 matches = ambiguous, could edit the wrong occurrence).
 * Sequential: each block's replace is applied before the next block's
 * search runs, so later blocks can target text a prior block just wrote.
 */
// Matches a stray protocol marker line (<<<<<<<, =======, >>>>>>>) inside a
// block's own text — real code should never contain these, so their
// presence means the model's response got tangled (nested/malformed blocks,
// or it echoed the format instructions back as content) rather than
// producing a real edit. Observed live: a REPLACE payload containing a
// marker line got spliced straight into a .ts file, producing a literal
// "Merge conflict marker encountered" compiler error — caught by the LSP
// auto-rollback gate that time, but only because verifyLspDiagnostics
// happened to be on for that call. This guard makes it fail the same
// (clean, no-op) way regardless of whether that gate is enabled.
const STRAY_MARKER_RE = /^(?:<{5,}|={5,}|>{5,})\s*(?:SEARCH|REPLACE)?\s*$/m;

/**
 * Finds where `searchLines` occurs in `workingLines`, trying progressively
 * looser matching so verbatim-quoting drift (the single biggest observed
 * cause of "SEARCH text not found" — a weak model reproducing a block with
 * different indentation/trailing whitespace but otherwise-correct content)
 * doesn't fail a block that a human would recognize as an unambiguous match.
 * Splitting on /\r?\n/ before this is ever called already makes line
 * boundaries CRLF-agnostic, so the tiers below are about per-line content
 * drift, not line-ending drift.
 *   Tier 1: exact line-for-line match.
 *   Tier 2: match after trimming each line (indentation/trailing-space only).
 * Each tier independently requires exactly one match — an exact match always
 * wins over a trimmed one, and a tier is never consulted if the previous
 * tier already found (even an ambiguous) match, so loosening the match never
 * silently overrides a real exact hit elsewhere in the file.
 */
// Matches a leading `L<number>: ` annotation — the format context-gatherer.ts
// uses to present grep excerpts to the model (`L${line}: ${content}`,
// context-gatherer.ts's grep-context formatting). Observed live: the model
// echoed this presentation-only annotation into BOTH the SEARCH and REPLACE
// text of a block ("L268: const callResult = ..."), so the exact/trimmed
// tiers correctly found zero matches (the real file has no such literal
// text) and the whole batch failed safely — but it's a real, generalizable
// failure mode worth a dedicated tolerant tier rather than just failing.
const LINE_NUMBER_PREFIX_RE = /^\s*L\d+:\s?/;

// Tolerant projections, modelled on OpenCode's replacer chain and Codex's seek_sequence: small models
// mangle quotes, dashes, spacing and indentation far more often than they get the code wrong.
const normalizeUnicode = (l: string) => l
  .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
  .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
  .replace(/[\u2010-\u2015\u2212]/g, '-')
  .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, ' ');
const collapseSpaces = (l: string) => normalizeUnicode(l).trim().replace(/\s+/g, ' ');

/** Character-bigram Dice similarity of two lines after normalization (0..1). */
function lineSimilarity(a: string, b: string): number {
  const x = collapseSpaces(a);
  const y = collapseSpaces(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  const gx = grams(x);
  const gy = grams(y);
  let overlap = 0;
  for (const [g, c] of gx) overlap += Math.min(c, gy.get(g) ?? 0);
  return (2 * overlap) / (x.length - 1 + y.length - 1);
}

/** Minimum average similarity of the MIDDLE lines for a first/last-line anchored match. */
const ANCHOR_MIDDLE_MIN = 0.6;

/**
 * The real file lines most similar to a failed SEARCH, with line numbers, so the retry can copy
 * exact text (Cline-style: a failed match is answered with what the file actually says).
 */
export function closestLines(workingLines: string[], searchLines: string[], maxLines = 6): string {
  const wanted = searchLines.map(l => l.trim()).filter(Boolean).slice(0, 3);
  if (wanted.length === 0) return '';
  const scored: Array<{ i: number; score: number }> = [];
  for (let i = 0; i < workingLines.length; i++) {
    if (!workingLines[i].trim()) continue;
    const score = Math.max(...wanted.map(w => lineSimilarity(workingLines[i], w)));
    if (score >= 0.55) {
      scored.push({ i, score });
    } else {
      const have = new Set(workingLines[i].toLowerCase().match(/[a-z_$][a-z0-9_$]*/g) ?? []);
      const shared = new Set((wanted.join(' ').toLowerCase().match(/[a-z_$][a-z0-9_$]*/g) ?? []).filter(w => have.has(w))).size;
      if (shared >= 2) scored.push({ i, score: shared / 100 });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const top = scored.slice(0, maxLines).sort((a, b) => a.i - b.i);
  return top.map(t => `L${t.i + 1}: ${workingLines[t.i].slice(0, 200)}`).join('\n');
}

export function findLineBlockMatch(
  workingLines: string[],
  searchLines: string[]
): { index: number; ambiguous: boolean; usedLineNumberStrip: boolean } {
  const tryTier = (project: (l: string) => string): number[] => {
    const hits: number[] = [];
    const projSearch = searchLines.map(project);
    for (let i = 0; i + searchLines.length <= workingLines.length; i++) {
      let matches = true;
      for (let j = 0; j < searchLines.length; j++) {
        if (project(workingLines[i + j]) !== projSearch[j]) { matches = false; break; }
      }
      if (matches) hits.push(i);
    }
    return hits;
  };

  const exact = tryTier(l => l);
  if (exact.length > 0) return { index: exact[0], ambiguous: exact.length > 1, usedLineNumberStrip: false };

  const trimmed = tryTier(l => l.trim());
  if (trimmed.length > 0) return { index: trimmed[0], ambiguous: trimmed.length > 1, usedLineNumberStrip: false };

  // Only worth trying when the SEARCH text itself actually carries the
  // annotation — otherwise this tier is identical to the trimmed one above
  // and would just re-do the same scan for nothing.
  if (searchLines.some(l => LINE_NUMBER_PREFIX_RE.test(l))) {
    const lineNumberStripped = tryTier(l => l.trim().replace(LINE_NUMBER_PREFIX_RE, ''));
    if (lineNumberStripped.length > 0) return { index: lineNumberStripped[0], ambiguous: lineNumberStripped.length > 1, usedLineNumberStrip: true };
  }

  // Quotes, dashes and non-breaking spaces; internal whitespace runs collapsed.
  const collapsed = tryTier(collapseSpaces);
  if (collapsed.length > 0) return { index: collapsed[0], ambiguous: collapsed.length > 1, usedLineNumberStrip: false };

  // First and last line match exactly (after normalization) and the lines in between are close
  // enough. Needs >= 3 lines; two equally good candidates are ambiguous, never guessed.
  if (searchLines.length >= 3) {
    const n = searchLines.length;
    const first = collapseSpaces(searchLines[0]);
    const last = collapseSpaces(searchLines[n - 1]);
    const good: number[] = [];
    for (let i = 0; i + n <= workingLines.length; i++) {
      if (collapseSpaces(workingLines[i]) !== first || collapseSpaces(workingLines[i + n - 1]) !== last) continue;
      let sum = 0;
      for (let j = 1; j < n - 1; j++) sum += lineSimilarity(workingLines[i + j], searchLines[j]);
      if (sum / (n - 2) >= ANCHOR_MIDDLE_MIN) good.push(i);
    }
    if (good.length > 0) return { index: good[0], ambiguous: good.length > 1, usedLineNumberStrip: false };
  }

  return { index: -1, ambiguous: false, usedLineNumberStrip: false };
}

export interface ApplyOptions {
  /**
   * The instruction only ADDS code. Every non-blank SEARCH line must then survive in REPLACE
   * (trimmed comparison); a small model that "adds" by rewriting the anchor deletes working code.
   */
  additive?: boolean;
  /** Treat an empty SEARCH as "append to the end of the file" instead of an error. */
  allowAppend?: boolean;
}

const ADD_WORDS = /\b(add|insert|append|introduce|implement|create|new)\b/i;
const CHANGE_WORDS = /\b(remove|delete|replace|rename|change|fix|rewrite|refactor|modify|update|swap|drop|move)\b/i;

/** True for instructions that only add code (so REPLACE must keep its SEARCH anchor). */
export function isAdditiveInstruction(instruction: string): boolean {
  return ADD_WORDS.test(instruction) && !CHANGE_WORDS.test(instruction);
}

/**
 * The matcher tolerates indentation differences, so a block the model copied 4 spaces too deep still
 * matches; without this its REPLACE would land 4 spaces too deep too. Shift REPLACE by the same delta,
 * but only for a uniform, spaces-only delta; anything else is left as written.
 */
export function reindentReplace(searchLines: string[], fileLines: string[], replaceLines: string[]): string[] {
  const lead = (l: string) => l.match(/^[ 	]*/)![0];
  let delta: number | null = null;
  for (let i = 0; i < searchLines.length; i++) {
    const s = searchLines[i], f = fileLines[i] ?? '';
    if (!s.trim()) continue;
    const ls = lead(s), lf = lead(f);
    if (ls.includes('	') || lf.includes('	')) return replaceLines;
    const d = lf.length - ls.length;
    if (delta === null) delta = d;
    else if (d !== delta) return replaceLines;
  }
  if (!delta) return replaceLines;
  if (delta > 0) return replaceLines.map(l => (l.trim() ? ' '.repeat(delta!) + l : l));
  const cut = -delta;
  if (replaceLines.some(l => l.trim() && !l.startsWith(' '.repeat(cut)))) return replaceLines;
  return replaceLines.map(l => (l.trim() ? l.slice(cut) : l));
}

export function applySearchReplaceBlocks(
  content: string,
  blocks: SearchReplaceBlock[],
  options: ApplyOptions = {}
): { content: string; appliedCount: number; failures: string[] } {
  // CRLF-agnostic by construction (each line's own ending is discarded by
  // the split), and rejoined with whichever ending the original file
  // predominantly used, so touching a couple of lines doesn't flip the
  // whole file's line endings (this repo has files with mixed endings).
  const usesCrlf = /\r\n/.test(content);
  const eol = usesCrlf ? '\r\n' : '\n';
  let workingLines = content.split(/\r?\n/);
  let appliedCount = 0;
  const failures: string[] = [];

  for (const { search, replace } of blocks) {
    if (!search || workingLines.every(l => l.trim() === '')) {
      if (options.allowAppend || content.trim() === '') {
        // New or empty file, or an explicit append: the text goes at the end.
        const addition = replace.split(/\r?\n/);
        const base = workingLines.length === 1 && workingLines[0] === '' ? [] : workingLines;
        const trimmed = base.length > 0 && base[base.length - 1] === '' ? base.slice(0, -1) : base;
        workingLines = [...trimmed, ...addition, ...(base.length > 0 && base[base.length - 1] === '' ? [''] : [])];
        appliedCount++;
        continue;
      }
      failures.push('Empty SEARCH block: include one or more existing lines as the anchor in SEARCH, and repeat them in REPLACE together with the new lines');
      continue;
    }
    if (STRAY_MARKER_RE.test(search) || STRAY_MARKER_RE.test(replace)) {
      failures.push('Block contains a stray SEARCH/REPLACE marker line (malformed/nested response) — not applied');
      continue;
    }
    const searchLines = search.split(/\r?\n/);
    const { index, ambiguous, usedLineNumberStrip } = findLineBlockMatch(workingLines, searchLines);
    if (index === -1) {
      const near = closestLines(workingLines, searchLines);
      failures.push(`SEARCH text not found (even with whitespace-tolerant matching): ${JSON.stringify(search.slice(0, 80))}${search.length > 80 ? '…' : ''}${near ? `. The file actually contains these similar lines, copy them exactly:\n${near}` : ''}`);
    } else if (ambiguous) {
      failures.push(`SEARCH text matched multiple times (ambiguous, must be unique): ${JSON.stringify(search.slice(0, 80))}${search.length > 80 ? '…' : ''}`);
    } else {
      // If the match only succeeded after stripping a bogus "L<N>: " prefix
      // from SEARCH, the model very likely echoed the same annotation into
      // REPLACE too (observed live, symmetric on both sides of the block) —
      // strip it there as well, or the "fix" would insert that literal
      // presentation-only text into the real file.
      const replaceLines = (usedLineNumberStrip ? replace.replace(new RegExp(LINE_NUMBER_PREFIX_RE.source, 'gm'), '') : replace).split(/\r?\n/);
      if (options.additive) {
        const kept = new Set(replaceLines.map(l => l.trim()).filter(Boolean));
        // A line that reappears changed (same start, e.g. a new parameter) was modified, not dropped:
        // "Add currency support" legitimately turns formatPrice(cents) into formatPrice(cents, currency).
        const modified = (l: string) => replaceLines.some(r => {
          const t = r.trim();
          let k = 0;
          while (k < l.length && k < t.length && l[k] === t[k]) k++;
          return k >= Math.max(12, Math.floor(l.length * 0.6));
        });
        const dropped = searchLines.map(l => l.trim()).filter(l => l && !kept.has(l) && !modified(l));
        if (dropped.length > 0) {
          failures.push(`anchor not retained: REPLACE dropped existing line(s) ${JSON.stringify(dropped[0].slice(0, 60))}${dropped.length > 1 ? ` (+${dropped.length - 1} more)` : ''} but the instruction only adds code; repeat the SEARCH lines in REPLACE and add the new lines after them`);
          continue;
        }
      }
      const placed = reindentReplace(searchLines, workingLines.slice(index, index + searchLines.length), replaceLines);
      workingLines = [
        ...workingLines.slice(0, index),
        ...placed,
        ...workingLines.slice(index + searchLines.length),
      ];
      appliedCount++;
    }
  }
  return { content: workingLines.join(eol), appliedCount, failures };
}

/**
 * Error-delta gate for TS/JS SEARCH/REPLACE results: a batch of blocks can
 * each individually match and apply cleanly while the COMBINATION leaves the
 * file in a worse state than before — observed live: fixing one method's
 * signature to async without simultaneously updating its call sites turned
 * 8 compiler errors into 18. Since ts-morph's in-memory check is cheap and
 * synchronous-enough to run inline, accept a SEARCH/REPLACE result for TS/JS
 * only if it doesn't increase the real (syntax + semantic) error count
 * relative to the pre-patch content — otherwise reject the whole batch
 * atomically rather than leaving a partially-migrated, worse-than-before file.
 * Non-TS/JS files skip this (no ts-morph checker available) and rely solely
 * on the guards above.
 */
/** TS diagnostics caused only by the in-memory check's missing environment: unresolved modules (2307, 2792),
 *  missing declaration files (7016) and node globals without @types/node (2580, 2591, 2584). */
const ENVIRONMENT_ONLY_TS_CODES = new Set([2307, 2792, 7016, 2580, 2591, 2584]);

export async function searchReplaceRegressesTsErrors(
  filePath: string,
  beforeContent: string,
  afterContent: string
): Promise<boolean> {
  if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(filePath)) return false;
  // The in-memory project has no node_modules, no @types/node and no sibling files, so every import and
  // every node global is an error there. Counting those made any edit that adds an import look like a
  // regression and threw correct edits away. Only errors in the code itself count.
  const countErrors = (diags: DiagnosticResult[]) =>
    diags.filter(d => d.severity === 'error' && !ENVIRONMENT_ONLY_TS_CODES.has(d.code ?? -1)).length;
  const [before, after] = await Promise.all([
    runTsMorphCheck(filePath, beforeContent),
    runTsMorphCheck(filePath, afterContent),
  ]);
  return countErrors(after) > countErrors(before);
}

export function looksLikeHallucinatedReplacement(originalContent: string, patchedContent: string): boolean {
  // A stray leading markdown fence marker means extractCodeBlock's stripping
  // didn't fully work (e.g. an unclosed/truncated fence) — the content itself
  // can be otherwise faithful, so the symbol/overlap checks below wouldn't
  // catch it, but "```" is never valid as the first line of any real source
  // file this pipeline targets. Reject outright rather than write it to disk.
  if (/^```/.test(patchedContent.trimStart())) return true;
  // Cloud models sometimes "regenerate" a large file but elide unchanged
  // stretches with a literal three-dot placeholder ("...") instead of
  // reproducing them — silently deleting real sections (nav tabs, attrs,
  // whole blocks). Real source/markup in this repo never contains a bare
  // "..." token (legitimate ellipsis text uses the single Unicode "…" char),
  // so any INCREASE in literal "..." occurrences vs the original is a
  // reliable truncation signal — independent of overall line-overlap %,
  // which this failure mode can otherwise still clear on a large file.
  const countEllipsis = (s: string) => (s.match(/(?<!\.)\.{3}(?!\.)/g) || []).length;
  if (countEllipsis(patchedContent) > countEllipsis(originalContent)) return true;
  // A full-file reply that keeps a landmark or two but is a fraction of the original has dropped real code
  // (observed live: 711 lines replaced by 102). Targeted edits go through SEARCH/REPLACE, never this path.
  const lineCount = (s: string) => s.split(/\r?\n/).length;
  if (lineCount(originalContent) >= 100 && lineCount(patchedContent) < lineCount(originalContent) * 0.4) return true;
  // `export` is only legal at module top level in TS/JS — never inside a
  // function or class method body — so requiring it (rather than making it
  // optional) restricts anchors to real public symbols and excludes generic
  // local variable/const names declared inside methods (e.g. `const key = `),
  // which previously produced false-negative "survived" matches purely by
  // coincidence (any method's local `key`/`value`/`data` would "anchor").
  const declPattern = /^\s*export\s+(?:default\s+)?(?:abstract\s+)?(?:class|interface|function|const|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  const anchors = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = declPattern.exec(originalContent)) !== null) {
    anchors.add(m[1]);
  }
  // Also extract top-level function declarations for non-module scripts
  // (classic browser JS: `function foo(`, `async function bar(`).
  // These are stable landmarks that survive any real edit.
  const jsFnPattern = /^(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gm;
  while ((m = jsFnPattern.exec(originalContent)) !== null) {
    anchors.add(m[1]);
  }
  // No exported symbols AND no top-level functions (pure HTML/CSS):
  // fall back to line overlap. An edit/append keeps most original lines;
  // a hallucinated wholesale replacement keeps almost none.
  if (anchors.size === 0) {
    const origLines = originalContent.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 3);
    if (origLines.length < 10) return false;
    const patchedSet = new Set(patchedContent.split(/\r?\n/).map(l => l.trim()));
    const kept = origLines.filter(l => patchedSet.has(l)).length;
    return kept / origLines.length < 0.5;
  }
  for (const name of anchors) {
    if (patchedContent.includes(name)) return false;
  }
  return true;
}

const REFUSAL_PATTERNS = [
  /I(?:'m| am)? sorry(?:,| but)? I can(?:'t| not) assist/i,
  /I cannot fulfill this request/i,
  /I am unable to assist with/i,
  /as an ai language model/i,
];

/**
 * Generates a patch via SEARCH/REPLACE blocks instead of full-content
 * reproduction — see parseSearchReplaceBlocks/applySearchReplaceBlocks above
 * for why. Used for the cloud fallback path in Step 4a — the local-model
 * attempt goes through localLlmPatch's own outputFormat:'search-replace'
 * instead, to share its model-invocation/refusal-detection/test-mock seam.
 * `chat` abstracts over whichever backend calls this. A window is still
 * used to keep the PROMPT small on large files, but unlike the old
 * windowed-splice approach, applySearchReplaceBlocks matches against the
 * FULL current content by exact text — there's no line-offset bookkeeping
 * to get wrong, and no requirement that the model reproduce anything.
 */
export async function generateSearchReplacePatch(
  currentContent: string,
  instruction: string,
  filename: string,
  tasksContext: string | undefined,
  chat: (prompt: string) => Promise<string>
): Promise<{ content: string; appliedCount: number; failures: string[]; hardFailure?: string }> {
  const lineCount = currentContent.split(/\r?\n/).length;
  const windowInfo = lineCount > 150 ? extractWindowForInstruction(currentContent, instruction, 150) : null;
  const contextText = windowInfo ? windowInfo.window : currentContent;
  const contextLabel = windowInfo
    ? `lines ${windowInfo.startIdx + 1}–${windowInfo.endIdx} of ${filename} (${windowInfo.lineCount} lines total)`
    : filename;

  const prompt = [
    `You are editing ${filename}. Shown below is ${windowInfo ? 'an excerpt of' : 'the content of'} the file — ONLY so you can find exact text to change. You do not need to reproduce it.`,
    tasksContext ? `## Active Task & DAG Plan\n${tasksContext}` : '',
    `## Instruction\n${instruction}`,
    `## ${windowInfo ? 'Excerpt' : 'Content'} (${contextLabel})\n\`\`\`\n${contextText}\n\`\`\``,
    [
      '## Output format',
      'Return one or more blocks in EXACTLY this format and nothing else — no explanations, no code fence around the blocks themselves:',
      '<<<<<<< SEARCH',
      '(exact existing text to find, copied verbatim character-for-character from above, including original whitespace/indentation)',
      '=======',
      '(the replacement text)',
      '>>>>>>> REPLACE',
      'Rules:',
      '1. SEARCH text must match the shown content exactly and must be unique (usually 1–5 lines — include enough surrounding text to make it unambiguous).',
      '2. Do not paraphrase or reformat SEARCH text.',
      '3. To ADD lines while retaining existing code: include the anchor line(s) in SEARCH, and in REPLACE include both the anchor line(s) AND the new lines. NEVER leave SEARCH empty.',
      '4. Emit multiple blocks if the instruction requires edits in more than one place.',
    ].join('\n'),
  ].filter(Boolean).join('\n\n');

  let raw: string;
  try {
    raw = await chat(prompt);
  } catch (err: any) {
    return { content: currentContent, appliedCount: 0, failures: [], hardFailure: `LLM call failed: ${err.message}` };
  }
  if (!raw?.trim()) {
    return { content: currentContent, appliedCount: 0, failures: [], hardFailure: 'Empty response from LLM' };
  }
  if (REFUSAL_PATTERNS.some(p => p.test(raw))) {
    return { content: currentContent, appliedCount: 0, failures: [], hardFailure: `Model refused request ("${raw.trim().slice(0, 200)}")` };
  }

  const { blocks, incomplete } = parseSearchReplaceBlocksDetailed(raw);
  if (blocks.length === 0) {
    return { content: currentContent, appliedCount: 0, failures: [], hardFailure: 'No SEARCH/REPLACE blocks found in response' };
  }

  const { content, appliedCount, failures } = applySearchReplaceBlocks(currentContent, blocks, { additive: isAdditiveInstruction(instruction) });
  if (incomplete > 0) failures.push(`${incomplete} block(s) were cut off before the REPLACE marker and were not applied`);
  return { content, appliedCount, failures };
}

export async function generateCodePatchWithCloudLLM(
  filePath: string,
  instruction: string,
  currentContent: string,
  workspaceRoot: string,
  sessionId: string,
  tasksContext?: string
): Promise<{ patch: string | null; failureReason?: string }> {
  try {
    const { useFreeLLM } = await import('../use-free-llm.js');
    const filename = path.basename(filePath);

    // For large non-module files (HTML, classic browser JS — no `export` declarations),
    // asking for COMPLETE file causes LLMs to truncate → hallucination guard fires.
    // Instead, use a sliding window: extract ~120 lines around the best anchor,
    // ask LLM to patch ONLY that window, then splice back into the full content.
    // The spliced result keeps 99%+ original lines → guard passes automatically.
    const hasExports = /^\s*export\s+/m.test(currentContent);
    const windowInfo = !hasExports ? extractWindowForInstruction(currentContent, instruction) : null;

    let prompt: string;
    let systemContent: string;

    if (windowInfo) {
      const { window, startIdx, endIdx, lineCount } = windowInfo;
      prompt = [
        `You are editing a specific section of ${filename} (${lineCount} lines total).`,
        `Edit ONLY the lines shown below (lines ${startIdx + 1}–${endIdx} of the file).`,
        `Return ONLY those lines — no omission markers, no extra commentary. Wrap in one code fence.`,
        `The surrounding file content outside this window is preserved unchanged.`,
        tasksContext ? `## Active Task & DAG Plan\n${tasksContext}` : '',
        `## Instruction\n${instruction}`,
        `## Lines ${startIdx + 1}–${endIdx} of ${filename}\n\`\`\`\n${window}\n\`\`\``,
      ].filter(Boolean).join('\n\n');
      systemContent = 'You are an elite coding assistant. Return ONLY the updated window lines inside one code fence. Do NOT return the rest of the file.';
    } else {
      prompt = [
        `You are patching a single file: ${filename}.`,
        `Apply the instruction and return the COMPLETE updated file content only, inside a single code fence.`,
        `Do not include conversational text, pleasantries, apologies, or explanations outside the code fence.`,
        tasksContext ? `## Active Task & DAG Plan\n${tasksContext}` : '',
        `## Instruction\n${instruction}`,
        `## Current Content of ${filename}\n\`\`\`\n${currentContent}\n\`\`\``,
      ].filter(Boolean).join('\n\n');
      systemContent = 'You are an elite coding assistant. Return only the full updated file in a code block.';
    }

    const res = await useFreeLLM({
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: prompt }
      ],
      keywords: ['coding', 'qwen', 'deepseek', 'codellama', 'coder'],
      taskType: 'coding',
      workspace_root: workspaceRoot,
      sessionId,
      isOnePass: true,
      skipIndexing: true,
    });

    const raw = res?.choices?.[0]?.message?.content || (res as any)?.content || (typeof res === 'string' ? res : '');
    if (raw && typeof raw === 'string') {
      const refusalPatterns = [
        /I(?:'m| am)? sorry(?:,| but)? I can(?:'t| not) assist/i,
        /I cannot fulfill this request/i,
        /I am unable to assist with/i,
        /as an ai language model/i,
      ];
      if (refusalPatterns.some(p => p.test(raw))) {
        return {
          patch: null,
          failureReason: `Cloud model refused request ("${raw.trim()}"). Refusal detected.`,
        };
      }

      const extracted = extractCodeBlock(raw);
      if (extracted?.trim()) {
        if (windowInfo) {
          const patchedWindowLines = extracted.split(/\r?\n/);
          const origLines = currentContent.split(/\r?\n/);
          const originalWindowLines = origLines.slice(windowInfo.startIdx, windowInfo.endIdx);
          // Same window-fidelity check as the local-model path: a reply that
          // mangles the excerpt (collapses, duplicates, or drops lines) still
          // clears the whole-file overlap check below (the loss is small
          // relative to the WHOLE file), so it must be caught here first.
          if (windowReplyIsSuspicious(originalWindowLines, patchedWindowLines)) {
            return {
              patch: null,
              failureReason: `Cloud model mangled a ${originalWindowLines.length}-line excerpt instead of reproducing it verbatim (duplicated/dropped/reordered lines) — not used.`,
            };
          }
          // Splice the patched window back into the full file content.
          // Result ≈ original + small edit → looksLikeHallucinatedReplacement passes.
          const spliced = [
            ...origLines.slice(0, windowInfo.startIdx),
            ...patchedWindowLines,
            ...origLines.slice(windowInfo.endIdx),
          ].join('\n');
          return { patch: spliced };
        }
        return { patch: extracted };
      }
      return { patch: null, failureReason: 'Model response contained no code block' };
    }
    return { patch: null, failureReason: 'Empty response received from LLM' };
  } catch (err: any) {
    const failureReason = `Cloud LLM generation error: ${err.message || String(err)}`;
    console.warn(`[coding-agents] ${failureReason}`);
    return { patch: null, failureReason };
  }
}

/**
 * True when a proposed file equals the original (ignoring CR and trailing blank lines). A model can
 * return the original text unchanged, and dryRun:true never runs a model at all; neither should be
 * presented as a proposed patch.
 */
export function isNoopPatch(before: string[], after: string[]): boolean {
  const norm = (ls: string[]) => {
    const out = ls.map(l => l.replace(/\r$/, ''));
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out;
  };
  const a = norm(before);
  const b = norm(after);
  return a.length === b.length && a.every((l, i) => l === b[i]);
}
