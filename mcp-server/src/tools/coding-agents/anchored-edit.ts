/**
 * A goal that quotes an anchor line and supplies the lines to add does not need a model: a script finds the
 * anchor and inserts the lines next to it. When the anchor is missing or ambiguous, the answer says so and the
 * caller falls back to showing the model a small window around it.
 */

export type AnchorPosition = 'before' | 'after';

export interface AnchoredGoal {
  position: AnchorPosition;
  anchor: string;
  anchorIsPrefix: boolean;
  lines: string[];
}

export type AnchorMatch =
  | { status: 'one'; index: number }
  | { status: 'many'; indexes: number[] }
  | { status: 'none' };

export type AnchoredResult =
  | { status: 'applied'; content: string }
  | { status: 'already_done' }
  | { status: 'ambiguous'; indexes: number[] }
  | { status: 'no_anchor' }
  | { status: 'not_applicable' };

/** The "after/before/above/below the line [that starts with] `anchor`" part of a goal, indentation of the anchor kept. */
function anchorClause(goal: string): Pick<AnchoredGoal, 'position' | 'anchor' | 'anchorIsPrefix'> | undefined {
  const m = /\b(after|before|above|below)\s+the\s+line\s+(that\s+starts\s+with\s+)?\u0060([^\u0060]+)\u0060/i.exec(goal);
  if (!m) return undefined;
  const word = m[1].toLowerCase();
  return { position: word === 'after' || word === 'below' ? 'after' : 'before', anchor: m[3], anchorIsPrefix: !!m[2] };
}

/** The backticked lines an "add the line(s) ..." request supplies, indentation kept; undefined when absent or negated. */
function addedLines(goal: string): string[] | undefined {
  const add = /\badd\b[^\u0060]*/i.exec(goal);
  if (!add) return undefined;
  if (/(?:do not|don't)\s+$/i.test(goal.slice(Math.max(0, add.index - 12), add.index))) return undefined;
  const after = goal.slice(add.index + add[0].length);
  const chain = /^\u0060[^\u0060]+\u0060(?:[\s,]*(?:and|then)?[\s,]*\u0060[^\u0060]+\u0060)*/.exec(after);
  return chain ? [...chain[0].matchAll(/\u0060([^\u0060]+)\u0060/g)].map(s => s[1]) : undefined;
}

/** True when the goal asks for one edit: one anchor clause, one add request, and no Edit or Step list. */
function isSingleEdit(goal: string): boolean {
  const count = (re: RegExp) => (goal.match(re) ?? []).length;
  return count(/\b(?:after|before|above|below)\s+the\s+line\b/gi) === 1 && count(/\badd\b/gi) === 1 && !/\b(?:edit|step)\s*\d/i.test(goal);
}

/** What an anchored goal asks for, or undefined when it has no anchor or no lines to add. */
export function parseAnchoredGoal(goal: string): AnchoredGoal | undefined {
  if (!isSingleEdit(goal)) return undefined;
  const clause = anchorClause(goal);
  const lines = addedLines(goal);
  return clause && lines && lines.length > 0 ? { ...clause, lines } : undefined;
}

/** The lines of content that equal the anchor (or start with it when anchorIsPrefix), ignoring trailing whitespace. */
export function findAnchor(content: string, anchor: string, anchorIsPrefix: boolean): AnchorMatch {
  const want = anchor.replace(/\s+$/, '');
  const indexes: number[] = [];
  content.split(/\r?\n/).forEach((line, i) => {
    const l = line.replace(/\s+$/, '');
    if (anchorIsPrefix ? l.startsWith(want) : l === want) indexes.push(i);
  });
  if (indexes.length === 0) return { status: 'none' };
  return indexes.length === 1 ? { status: 'one', index: indexes[0] } : { status: 'many', indexes };
}

/** Inserts the lines a goal supplies next to its anchor, keeping the file's line ending and every other line. */
export function applyAnchored(content: string, goal: string): AnchoredResult {
  const parsed = parseAnchoredGoal(goal);
  if (!parsed) return { status: 'not_applicable' };
  const match = findAnchor(content, parsed.anchor, parsed.anchorIsPrefix);
  if (match.status === 'none') return { status: 'no_anchor' };
  if (match.status === 'many') return { status: 'ambiguous', indexes: match.indexes };
  if (parsed.lines.every(line => content.includes(line))) return { status: 'already_done' };
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  lines.splice(parsed.position === 'after' ? match.index + 1 : match.index, 0, ...parsed.lines);
  return { status: 'applied', content: lines.join(eol) };
}

/** A window around the one line a goal quotes: 20 lines on the first try, 60 on the retry. Null when no quote picks one line. */
export function anchoredWindow(content: string, goal: string, attempt: number): { window: string; startIdx: number; endIdx: number; lineCount: number } | null {
  const lines = content.split(/\r?\n/);
  for (const span of goal.matchAll(/\u0060([^\u0060]+)\u0060/g)) {
    const quote = span[1].trim();
    if (quote.length < 8) continue;
    const hits = lines.flatMap((line, i) => (line.includes(quote) ? [i] : []));
    if (hits.length !== 1) return null;
    const { text, startIdx, endIdx } = anchorWindow(content, hits[0], attempt === 0 ? 20 : 60);
    return { window: text, startIdx, endIdx, lineCount: lines.length };
  }
  return null;
}

export interface AnchoredEdit { file: string; anchor: string; anchorIsPrefix?: boolean; position: AnchorPosition | 'replace'; lines: string[] }
/** Applies edits in order, all or nothing: a missing or ambiguous anchor changes nothing. */
export function applyEdits(content: string, edits: AnchoredEdit[]): AnchoredResult {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  let changed = false;
  for (const edit of edits) {
    const match = findAnchor(lines.join('\n'), edit.anchor, !!edit.anchorIsPrefix);
    const present = edit.lines.every(line => lines.includes(line));
    if (present && (edit.position !== 'replace' || match.status === 'none')) continue;
    if (match.status === 'none') return { status: 'no_anchor' };
    if (match.status === 'many') return { status: 'ambiguous', indexes: match.indexes };
    lines.splice(edit.position === 'after' ? match.index + 1 : match.index, edit.position === 'replace' ? 1 : 0, ...edit.lines);
    changed = true;
  }
  return changed ? { status: 'applied', content: lines.join(eol) } : { status: 'already_done' };
}
/** size lines of content centred on the line at index, kept inside the file; endIdx is exclusive. */
export function anchorWindow(content: string, index: number, size: number): { text: string; startIdx: number; endIdx: number } {
  const lines = content.split(/\r?\n/);
  const half = Math.floor(size / 2);
  const startIdx = Math.max(0, Math.min(index - half, lines.length - size));
  const endIdx = Math.min(lines.length, startIdx + size);
  return { text: lines.slice(startIdx, endIdx).join('\n'), startIdx, endIdx };
}
