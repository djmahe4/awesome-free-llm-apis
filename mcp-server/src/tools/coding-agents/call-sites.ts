/**
 * Call sites read from the tests, deterministically.
 *
 * The facts a rebuilt module most often gets wrong are in how the tests CALL it: how many arguments, and whether an argument
 * is an array or an object (`buildThing('s1', 'x', { messages: [...] })`). No model is needed to read them, and a model-written
 * contract can be checked against them: a bullet that says `buildThing(messages: any[])` for a call with three arguments is
 * wrong, whatever else it says.
 */

const MAX_CALL_CHARS = 420;
const MAX_CALLS_PER_NAME = 3;

export interface CallSite { name: string; args: string[]; text: string }

/** The index just after the parenthesis that closes the one at `open`, or -1. Aware of strings, template literals and comments. */
function closeOf(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) return -1; i++; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/** Top-level comma split of an argument list (nested brackets, strings and templates stay whole). */
export function splitArgs(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' || c === "'" || c === '`') { for (i++; i < inner.length && inner[i] !== c; i++) if (inner[i] === '\\') i++; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { out.push(inner.slice(start, i).trim()); start = i + 1; }
  }
  const last = inner.slice(start).trim();
  if (last) out.push(last);
  return out;
}

/** Calls to each of `names` in `source` (not method calls, not declarations), with their literal arguments. */
export function extractCallSites(source: string, names: string[]): Map<string, CallSite[]> {
  const found = new Map<string, CallSite[]>();
  for (const name of names) {
    const re = new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\(`, 'g');
    for (let m = re.exec(source); m; m = re.exec(source)) {
      const open = source.indexOf('(', m.index + m[1].length + name.length);
      const before = source.slice(Math.max(0, m.index - 16), m.index + m[1].length);
      if (/\b(?:function|import|from|class)\s*\*?\s*$/.test(before)) continue;
      const end = closeOf(source, open);
      if (end < 0) continue;
      const inner = source.slice(open + 1, end - 1);
      const text = `${name}(${inner.replace(/\s+/g, ' ').trim()})`;
      const list = found.get(name) ?? [];
      if (list.length < MAX_CALLS_PER_NAME && !list.some(c => c.text === text)) {
        list.push({ name, args: splitArgs(inner), text: text.length > MAX_CALL_CHARS ? `${text.slice(0, MAX_CALL_CHARS)} ...)` : text });
        found.set(name, list);
      }
    }
  }
  return found;
}

/** One bullet per call site, exactly as the tests write it. */
export function formatCallSites(sites: Map<string, CallSite[]>): string {
  const lines: string[] = [];
  for (const list of sites.values()) for (const c of list) lines.push(`- called as ${c.text}`);
  return lines.join('\n');
}

/** The parameter list of a bullet that starts "- name(...)", split at top level; undefined when it has none. */
function bulletParams(bullet: string, name: string): string[] | undefined {
  const at = bullet.indexOf(`${name}(`);
  if (at < 0) return undefined;
  const open = at + name.length;
  const end = closeOf(bullet, open);
  if (end < 0) return undefined;
  return splitArgs(bullet.slice(open + 1, end - 1));
}

/** Is this parameter declared as an array? The `name:` prefix is dropped first, so `thread: { messages: Array }` is an object. */
const looksArray = (param: string) => {
  const type = param.replace(/^\s*[\w$]+\??\s*:\s*/, '');
  return /\[\s*\]|\bArray\b|\bany\[\]|\bunknown\[\]/.test(type) && !/^\s*\{/.test(type);
};

/**
 * Drops the bullets whose signature contradicts the tests' calls: a different number of arguments than EVERY call passes, or an
 * array-typed parameter where the call passes an object literal. Bullets that quote the call itself always agree and are kept.
 */
export function validateContractBullets(bullets: string[], sites: Map<string, CallSite[]>): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const bullet of bullets) {
    const name = [...sites.keys()].find(n => new RegExp(`^-\\s*${n.replace(/\$/g, '\\$')}\\(`).test(bullet));
    const calls = name ? sites.get(name) ?? [] : [];
    const params = name ? bulletParams(bullet, name) : undefined;
    if (!name || !params || calls.length === 0) { kept.push(bullet); continue; }
    const arityOk = calls.some(c => c.args.length === params.length);
    const shapeOk = calls.some(c => c.args.length === params.length && c.args.every((a, i) => !(a.startsWith('{') && looksArray(params[i] ?? ''))));
    (arityOk && shapeOk ? kept : dropped).push(bullet);
  }
  return { kept, dropped };
}
