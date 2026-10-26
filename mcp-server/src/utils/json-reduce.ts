/**
 * Budget-driven JSON reduction for anything that ends up in a model's context.
 *
 * The old options for a big JSON result were all lossy in the wrong way: refuse it, or cut the raw text at N
 * characters (invalid JSON, and the part you wanted is usually not the first part). This keeps the document
 * valid and shrinks it in steps: optional `select` paths first (take only what the caller asked for), then, if
 * it still does not fit, progressively less detail - shorter strings, fewer array items (the ones matching
 * `query` first), fewer keys, shallower nesting - counting what was dropped so the reader knows.
 */

export interface ReduceOptions {
  /** Upper bound for JSON.stringify(result).length. */
  maxChars: number;
  /** Words describing what the caller needs; array items and keys that mention them are kept first. */
  query?: string;
  /** Paths to keep, e.g. "items.*.name" ("*" = every array element / object value, digits = an index). */
  select?: string[];
}

export interface ReduceInfo {
  reduced: boolean;
  selected: boolean;
  originalChars: number;
  reducedChars: number;
  /** 0 = nothing cut; higher = more detail removed. */
  level: number;
  omittedItems: number;
  note?: string;
}

interface Level { str: number; arr: number; keys: number; depth: number }
/** From generous to thin. The first level spends the budget it has: a lone 500 KB string with a 100 KB budget keeps ~80 KB of it. */
function levelsFor(maxChars: number): Level[] {
  return [
    { str: Math.max(500, Math.floor(maxChars * 0.8)), arr: 200, keys: 300, depth: 10 },
    { str: 500, arr: 20, keys: 80, depth: 8 },
    { str: 200, arr: 10, keys: 40, depth: 6 },
    { str: 120, arr: 5, keys: 25, depth: 4 },
    { str: 60, arr: 3, keys: 12, depth: 3 },
    { str: 40, arr: 2, keys: 8, depth: 2 },
  ];
}

const size = (v: unknown): number => (v === undefined ? 0 : JSON.stringify(v).length);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function termsOf(query?: string): string[] {
  if (!query) return [];
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 3))].slice(0, 12);
}

function relevance(node: unknown, terms: string[]): number {
  if (terms.length === 0) return 0;
  let text: string;
  try { text = JSON.stringify(node).slice(0, 2000).toLowerCase(); } catch { return 0; }
  return terms.reduce((n, t) => n + (text.includes(t) ? 1 : 0), 0);
}

// ---- select -------------------------------------------------------------------------------------------------

function pick(node: unknown, segs: string[]): unknown {
  if (segs.length === 0) return node;
  const [head, ...rest] = segs;
  if (Array.isArray(node)) {
    if (head === '*') return node.map(n => pick(n, rest) ?? {}); // keep positions aligned so several paths merge per element
    if (/^\d+$/.test(head)) {
      const sub = pick(node[Number(head)], rest);
      return sub === undefined ? undefined : [sub];
    }
    return undefined;
  }
  if (isObj(node)) {
    if (head === '*') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        const sub = pick(v, rest);
        if (sub !== undefined) out[k] = sub;
      }
      return Object.keys(out).length ? out : undefined;
    }
    if (head in node) {
      const sub = pick(node[head], rest);
      return sub === undefined ? undefined : { [head]: sub };
    }
  }
  return undefined;
}

function merge(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b)) {
    const out = a.length >= b.length ? [...a] : [...b];
    for (let i = 0; i < Math.min(a.length, b.length); i++) out[i] = merge(a[i], b[i]);
    return out;
  }
  if (isObj(a) && isObj(b)) {
    const out: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v;
    return out;
  }
  return b;
}

/** Elements a "*" path could not fill are empty objects: drop them from arrays. */
function prune(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(prune).filter(n => !(isObj(n) && Object.keys(n).length === 0));
  if (isObj(node)) return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, prune(v)]));
  return node;
}

function project(value: unknown, paths: string[]): unknown {
  let out: unknown;
  for (const p of paths) {
    const part = pick(value, p.split('.').filter(Boolean));
    if (part !== undefined) out = out === undefined ? part : merge(out, part);
  }
  return out === undefined ? {} : prune(out);
}

// ---- shrink -------------------------------------------------------------------------------------------------

interface Stats { omitted: number }

function shrink(node: unknown, lv: Level, depth: number, terms: string[], stats: Stats): unknown {
  if (typeof node === 'string') {
    return node.length > lv.str ? `${node.slice(0, lv.str)}...[+${node.length - lv.str} chars]` : node;
  }
  if (Array.isArray(node)) {
    if (depth >= lv.depth) return `[array of ${node.length} items]`;
    let chosen = node.map((_, i) => i);
    if (node.length > lv.arr) {
      const ranked = node.map((n, i) => ({ i, score: relevance(n, terms) })).sort((x, y) => y.score - x.score || x.i - y.i);
      chosen = ranked.slice(0, lv.arr).map(r => r.i).sort((x, y) => x - y);
    }
    const out: unknown[] = chosen.map(i => shrink(node[i], lv, depth + 1, terms, stats));
    if (chosen.length < node.length) {
      stats.omitted += node.length - chosen.length;
      out.push({ _omitted: node.length - chosen.length, _of: node.length });
    }
    return out;
  }
  if (isObj(node)) {
    const keys = Object.keys(node);
    if (depth >= lv.depth) return `[object with ${keys.length} keys: ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', ...' : ''}]`;
    let chosen = keys;
    if (keys.length > lv.keys) {
      const ranked = keys.map((k, i) => ({ k, i, score: relevance({ [k]: node[k] }, terms) })).sort((x, y) => y.score - x.score || x.i - y.i);
      const keep = new Set(ranked.slice(0, lv.keys).map(r => r.k));
      chosen = keys.filter(k => keep.has(k));
    }
    const out: Record<string, unknown> = {};
    for (const k of chosen) out[k] = shrink(node[k], lv, depth + 1, terms, stats);
    if (chosen.length < keys.length) {
      stats.omitted += keys.length - chosen.length;
      out._omittedKeys = keys.length - chosen.length;
    }
    return out;
  }
  return node;
}

/** Last resort when even the thinnest level does not fit: a description of the shape that does. */
function shapeOnly(value: unknown, maxChars: number): unknown {
  const describe = (v: unknown): string =>
    Array.isArray(v) ? `array(${v.length})`
      : isObj(v) ? `object(${Object.keys(v).length}): ${Object.keys(v).slice(0, 12).join(', ')}`
        : typeof v;
  const out = { _reduced: 'too large for the budget', shape: describe(value) };
  return size(out) <= maxChars ? out : { _reduced: 'too large' };
}

export function reduceJson(input: unknown, opts: ReduceOptions): { value: unknown; info: ReduceInfo } {
  const originalChars = size(input);
  const terms = termsOf(opts.query);
  const info: ReduceInfo = { reduced: false, selected: false, originalChars, reducedChars: originalChars, level: 0, omittedItems: 0 };

  let value = input;
  if (opts.select && opts.select.length > 0) {
    value = project(input, opts.select);
    info.selected = true;
    if (isObj(value) && Object.keys(value).length === 0) info.note = 'select matched nothing in this document';
  }
  if (size(value) <= opts.maxChars) {
    info.reducedChars = size(value);
    return { value, info };
  }

  const levels = levelsFor(opts.maxChars);
  for (let l = 0; l < levels.length; l++) {
    const stats: Stats = { omitted: 0 };
    const candidate = shrink(value, levels[l], 0, terms, stats);
    if (size(candidate) <= opts.maxChars) {
      return { value: candidate, info: { ...info, reduced: true, level: l + 1, omittedItems: stats.omitted, reducedChars: size(candidate) } };
    }
  }
  const fallback = shapeOnly(value, opts.maxChars);
  return { value: fallback, info: { ...info, reduced: true, level: levels.length + 1, reducedChars: size(fallback), note: 'only the shape fits the budget' } };
}
