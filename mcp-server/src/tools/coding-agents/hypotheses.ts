import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Hypotheses: the assumptions a plan rests on, each with a mechanical probe against the real files.
 *
 * A model proposes the claim and the probe; the verdict is computed here. Probes are deliberately limited to things
 * that can be decided by reading the workspace (a file exists, a name is defined, a function takes N parameters, a
 * pattern appears, cited lines still hash as recorded), so a wrong assumption (an invented file, a symbol that does
 * not exist, a wrong argument count) is refuted with evidence before any edit is made on top of it.
 */

export type HypothesisStatus = 'open' | 'confirmed' | 'refuted';

export interface Hypothesis {
  id: string;
  claim: string;
  probe: string;
  status: HypothesisStatus;
  evidence?: string;
}

export type Probe =
  | { kind: 'file'; path: string }
  | { kind: 'defined'; name: string }
  | { kind: 'symbol'; name: string; path: string }
  | { kind: 'arity'; name: string; path: string; expected: number }
  | { kind: 'grep'; pattern: string; path: string }
  | { kind: 'cite'; path: string; from: number; to: number; hash: string };

export interface ProbeResult { status: 'confirmed' | 'refuted'; evidence: string }

const IDENT = /^[A-Za-z_$][\w$]*$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PATTERN = 200;
const MAX_LINES = 20_000;

export function parseProbe(text: string): Probe | null {
  const t = (text ?? '').trim();
  const colon = t.indexOf(':');
  if (colon < 1) return null;
  const kind = t.slice(0, colon);
  const rest = t.slice(colon + 1);
  if (!rest.trim()) return null;

  if (kind === 'file') return { kind: 'file', path: rest.trim() };

  if (kind === 'defined') return IDENT.test(rest.trim()) ? { kind: 'defined', name: rest.trim() } : null;

  if (kind === 'symbol') {
    const at = rest.indexOf('@');
    const name = rest.slice(0, at), p = rest.slice(at + 1).trim();
    return at > 0 && IDENT.test(name) && p ? { kind: 'symbol', name, path: p } : null;
  }

  if (kind === 'arity') {
    const m = rest.match(/^([A-Za-z_$][\w$]*)@(.+)=(\d+)$/);
    return m ? { kind: 'arity', name: m[1], path: m[2].trim(), expected: Number(m[3]) } : null;
  }

  if (kind === 'grep') {
    const at = rest.lastIndexOf('@');
    const pattern = rest.slice(0, at), p = rest.slice(at + 1).trim();
    return at > 0 && p ? { kind: 'grep', pattern, path: p } : null;
  }

  if (kind === 'cite') {
    const m = rest.match(/^(.+):L(\d+)-L(\d+)#([0-9a-f]{4,64})$/);
    return m ? { kind: 'cite', path: m[1], from: Number(m[2]), to: Number(m[3]), hash: m[4] } : null;
  }

  return null;
}

// ---- parameters ----------------------------------------------------------------------------------------------

/** Number of parameters in a parameter list including its parentheses; `self`/`cls` are not counted. */
export function countParams(paramList: string): number {
  let s = paramList.trim();
  if (s.startsWith('(')) s = s.slice(1);
  if (s.endsWith(')')) s = s.slice(0, -1);
  if (!s.trim()) return 0;

  const parts: string[] = [];
  let depth = 0, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const prev = s[i - 1];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === '<') depth++;
    else if (c === '>' && prev !== '=' && prev !== '-') depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);

  const params = parts.map(p => p.trim()).filter(Boolean);
  // the receiver is not an argument: python self/cls, rust self / &self / &mut self
  if (params.length && /^(&\s*(mut\s+)?self|mut\s+self|self|cls)$/.test(params[0].split(/[:=]/)[0].trim())) params.shift();
  return params.length;
}

// ---- definitions ----------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'new', 'await', 'typeof']);

type Lang = 'ts' | 'py' | 'go' | 'rs';
function langOf(file: string): Lang | null {
  switch (path.extname(file).toLowerCase()) {
    case '.ts': case '.tsx': case '.js': case '.jsx': case '.mjs': case '.cjs': return 'ts';
    case '.py': return 'py';
    case '.go': return 'go';
    case '.rs': return 'rs';
    default: return null;
  }
}

function definitionPatterns(lang: Lang, name: string): RegExp[] {
  const n = esc(name);
  switch (lang) {
    case 'ts': return [
      new RegExp(`^\\s*(export\\s+)?(default\\s+)?(async\\s+)?function\\s*\\*?\\s+${n}\\b`),
      new RegExp(`^\\s*(export\\s+)?(declare\\s+)?(abstract\\s+)?(class|interface|enum|namespace)\\s+${n}\\b`),
      new RegExp(`^\\s*(export\\s+)?(declare\\s+)?type\\s+${n}\\b`),
      new RegExp(`^\\s*(export\\s+)?(declare\\s+)?(const|let|var)\\s+${n}\\b`),
      // a method: not a call (it has a body) and not a control statement
      new RegExp(`(^|[\\s{;}])(?:(?:public|private|protected|static|async|readonly|override)\\s+)*${n}\\s*(<[^>]*>)?\\s*\\([^()]*(\\([^()]*\\)[^()]*)*\\)\\s*(:\\s*[^={;]+)?\\s*\\{`),
    ];
    case 'py': return [new RegExp(`^\\s*(async\\s+)?def\\s+${n}\\b`), new RegExp(`^\\s*class\\s+${n}\\b`), new RegExp(`^${n}\\s*=`)];
    case 'go': return [new RegExp(`^func\\s+(\\([^)]*\\)\\s*)?${n}\\b`), new RegExp(`^(type|var|const)\\s+${n}\\b`)];
    case 'rs': return [new RegExp(`^\\s*(pub(\\([^)]*\\))?\\s+)?(async\\s+)?(unsafe\\s+)?fn\\s+${n}\\b`), new RegExp(`^\\s*(pub(\\([^)]*\\))?\\s+)?(struct|enum|trait|type|const|static|mod)\\s+${n}\\b`)];
  }
}

interface Definition { line: number; text: string }

function findDefinition(lines: string[], lang: Lang, name: string): Definition | null {
  const patterns = definitionPatterns(lang, name);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#') || trimmed.startsWith('/*')) continue;
    for (const re of patterns) {
      const m = re.exec(line);
      if (!m) continue;
      if (lang === 'ts' && patterns.indexOf(re) === patterns.length - 1) {
        const before = line.slice(0, m.index + m[1].length).trimEnd();
        if (before.endsWith('.') || KEYWORDS.has(name)) continue;
      }
      return { line: i + 1, text: line };
    }
  }
  return null;
}

/** The parameter list (with parentheses) that follows `name` at a definition, read across lines if needed. */
function paramListAfter(lines: string[], def: Definition, lang: Lang, name: string): string | null {
  const window = lines.slice(def.line - 1, def.line - 1 + 25).join('\n');
  // whole word: `f` must not match the end of `def`
  const at = window.search(new RegExp(`(?<![\\w$])${esc(name)}(?![\\w$])`));
  if (at < 0) return null;
  // The list must start right after the name: `fn name(`, `name<T>(`, or `name = (` / `name = async function (`.
  // Anything else (a class, interface, enum, struct, constant) has no parameter list of its own, and a '(' further
  // along belongs to something nested in it, such as a method.
  const after = window.slice(at + name.length);
  const direct = /^\s*(<[^>]*>)?\s*\(/.exec(after);
  const assigned = lang === 'ts' ? /^\s*(:[^=]*)?=\s*(async\s*)?(function\s*\*?\s*\w*\s*)?(<[^>]*>)?\s*\(/.exec(after) : null;
  const m = direct ?? assigned;
  if (!m) return null;
  const i = at + name.length + m[0].length - 1;
  let depth = 0;
  for (let j = i; j < window.length; j++) {
    if (window[j] === '(') depth++;
    else if (window[j] === ')') { depth--; if (depth === 0) return window.slice(i, j + 1); }
  }
  return null;
}

// ---- running probes ---------------------------------------------------------------------------------------------

function insideWorkspace(root: string, rel: string): string | null {
  if (!rel || rel.includes('\0')) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  return full === base || full.startsWith(base + path.sep) ? full : null;
}

async function readText(root: string, rel: string): Promise<{ ok: true; text: string; full: string } | { ok: false; evidence: string }> {
  const full = insideWorkspace(root, rel);
  if (!full) return { ok: false, evidence: `${rel}: outside the workspace` };
  try {
    const st = await fs.stat(full);
    if (!st.isFile()) return { ok: false, evidence: `${rel}: not a file` };
    if (st.size > MAX_FILE_BYTES) return { ok: false, evidence: `${rel}: too large to probe (${st.size} bytes)` };
    return { ok: true, text: await fs.readFile(full, 'utf-8'), full };
  } catch {
    return { ok: false, evidence: `${rel}: file not found` };
  }
}

const clip = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}...` : s);

export interface ProbeContext {
  /** Workspace-relative code files a `defined:` probe may search. */
  files?: string[];
}

export async function runProbe(probeText: string, workspaceRoot: string, ctx: ProbeContext = {}): Promise<ProbeResult> {
  const probe = parseProbe(probeText);
  if (!probe) return { status: 'refuted', evidence: `unrecognised probe "${clip(String(probeText))}" (use file:, defined:, symbol:, arity:, grep: or cite:)` };

  if (probe.kind === 'file') {
    const r = await readText(workspaceRoot, probe.path);
    return r.ok ? { status: 'confirmed', evidence: `${probe.path} exists` } : { status: 'refuted', evidence: r.evidence };
  }

  if (probe.kind === 'defined') {
    const files = ctx.files ?? [];
    if (files.length === 0) return { status: 'refuted', evidence: `no files to search for ${probe.name}` };
    for (const f of files) {
      const lang = langOf(f);
      if (!lang) continue;
      const r = await readText(workspaceRoot, f);
      if (!r.ok) continue;
      const def = findDefinition(r.text.split(/\r?\n/), lang, probe.name);
      if (def) return { status: 'confirmed', evidence: `${f}:L${def.line}: ${clip(def.text.trim())}` };
    }
    return { status: 'refuted', evidence: `${probe.name} is not defined in any of the ${files.length} file${files.length === 1 ? '' : 's'} searched` };
  }

  const file = await readText(workspaceRoot, probe.path);
  if (!file.ok) return { status: 'refuted', evidence: file.evidence };
  const lines = file.text.split(/\r?\n/);

  if (probe.kind === 'grep') {
    if (probe.pattern.length > MAX_PATTERN) return { status: 'refuted', evidence: `invalid pattern: longer than ${MAX_PATTERN} characters` };
    let re: RegExp;
    try { re = new RegExp(probe.pattern); } catch (e: any) { return { status: 'refuted', evidence: `invalid pattern: ${e?.message ?? e}` }; }
    for (let i = 0; i < Math.min(lines.length, MAX_LINES); i++) {
      if (re.test(lines[i])) return { status: 'confirmed', evidence: `${probe.path}:L${i + 1}: ${clip(lines[i].trim())}` };
    }
    return { status: 'refuted', evidence: `no line in ${probe.path} matches /${probe.pattern}/` };
  }

  if (probe.kind === 'cite') {
    if (probe.from < 1 || probe.to < probe.from || probe.to > lines.length) {
      return { status: 'refuted', evidence: `${probe.path} has ${lines.length} lines; L${probe.from}-L${probe.to} is out of range` };
    }
    const span = lines.slice(probe.from - 1, probe.to).join('\n');
    const got = crypto.createHash('sha256').update(span).digest('hex').slice(0, probe.hash.length);
    return got === probe.hash
      ? { status: 'confirmed', evidence: `${probe.path}:L${probe.from}-L${probe.to} still hashes to ${probe.hash}` }
      : { status: 'refuted', evidence: `${probe.path}:L${probe.from}-L${probe.to} changed (hash ${got}, cited ${probe.hash})` };
  }

  const lang = langOf(probe.path);
  if (!lang) return { status: 'refuted', evidence: `${probe.path}: no ${probe.kind} probe for this language; use grep:` };
  const def = findDefinition(lines, lang, probe.name);
  if (!def) return { status: 'refuted', evidence: `no definition of ${probe.name} in ${probe.path}` };

  if (probe.kind === 'symbol') {
    return { status: 'confirmed', evidence: `${probe.path}:L${def.line}: ${clip(def.text.trim())}` };
  }

  const params = paramListAfter(lines, def, lang, probe.name);
  if (params === null) return { status: 'refuted', evidence: `${probe.name} at ${probe.path}:L${def.line} is not a function or method, so it has no parameter list to count` };
  const actual = countParams(params);
  return actual === probe.expected
    ? { status: 'confirmed', evidence: `${probe.name} takes ${actual} parameter${actual === 1 ? '' : 's'} (${probe.path}:L${def.line})` }
    : { status: 'refuted', evidence: `${probe.name} takes ${actual} parameter${actual === 1 ? '' : 's'}, not ${probe.expected} (${probe.path}:L${def.line})` };
}

/** Runs every probe. The status a model wrote is ignored: the probe decides. */
export async function validateHypotheses(list: Hypothesis[], workspaceRoot: string, ctx: ProbeContext = {}): Promise<Hypothesis[]> {
  const out: Hypothesis[] = [];
  for (const h of list) {
    const r = await runProbe(h.probe, workspaceRoot, ctx);
    out.push({ id: h.id, claim: h.claim, probe: h.probe, status: r.status, evidence: r.evidence });
  }
  return out;
}

// ---- hypotheses.md ------------------------------------------------------------------------------------------------

const BS = String.fromCharCode(92);
const escCell = (s: string) => s.split(BS).join(BS + BS).split('|').join(BS + '|').replace(/\r?\n/g, ' ');

function splitRow(row: string): string[] {
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === BS && i + 1 < row.length) { cur += row[i + 1] === '|' ? '|' : row[i + 1] === BS ? BS : c + row[i + 1]; i++; continue; }
    if (c === '|') { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  return cells.slice(1, -1).map(c => c.trim());
}

export function serializeHypothesisRow(h: Hypothesis): string {
  return `| ${escCell(h.id)} | ${escCell(h.claim)} | \`${escCell(h.probe)}\` | ${h.status} | ${escCell(h.evidence ?? '')} |`;
}

export function serializeHypothesesMarkdown(goal: string, list: Hypothesis[]): string {
  const rows = list.map(serializeHypothesisRow);
  return [`# Hypotheses: ${goal.split(/\r?\n/)[0]}`, '', '| id | claim | probe | status | evidence |', '|----|-------|-------|--------|----------|', ...rows, ''].join('\n');
}

export function parseHypothesesMarkdown(md: string): Hypothesis[] {
  const out: Hypothesis[] = [];
  for (const line of md.split(/\r?\n/)) {
    if (!line.startsWith('|') || /^\|\s*-/.test(line) || /^\|\s*id\s*\|/i.test(line)) continue;
    const cells = splitRow(line);
    if (cells.length < 5) continue;
    const [id, claim, probeCell, status, evidence] = cells;
    if (!id || !['open', 'confirmed', 'refuted'].includes(status)) continue;
    const probe = probeCell.startsWith('`') && probeCell.endsWith('`') ? probeCell.slice(1, -1) : probeCell;
    out.push({ id, claim, probe, status: status as HypothesisStatus, ...(evidence ? { evidence } : {}) });
  }
  return out;
}
