/**
 * Input-schema drift: for every tool in src/mcp/index.ts, follow the handler it calls to the module it is
 * imported from, read the handler's input type, and report caller-facing fields missing from the MCP
 * inputSchema. A field meant only for internal callers is marked `@internal` in its JSDoc.
 * Pure string functions (no TS compiler), so the pre-commit check stays fast; unit-tested.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface HandlerRef { fn: string; module: string }
export interface InputFields { fields: string[]; internal: string[] }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The handler a tool's dispatch branch awaits, and the module it comes from (static or dynamic import). */
export function handlerForTool(indexSrc: string, tool: string): HandlerRef | null {
  const start = indexSrc.search(new RegExp(`name === '${esc(tool)}'`));
  if (start < 0) return null;
  const rest = indexSrc.slice(start);
  const next = rest.slice(1).search(/\}\s*else if \(name === '|\n\s*\}\s*else\s*\{/);
  const branch = next >= 0 ? rest.slice(0, next + 1) : rest;
  const call = branch.match(/await\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/);
  if (!call || call[2].trim() === '' || call[1] === 'import') {
    // a dynamic import line comes first; take the call after it
    const calls = [...branch.matchAll(/await\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)].filter(c => c[1] !== 'import' && c[2].trim() !== '');
    if (calls.length === 0) return null;
    return resolveModule(indexSrc, branch, calls[0][1]);
  }
  return resolveModule(indexSrc, branch, call[1]);
}

function resolveModule(indexSrc: string, branch: string, fn: string): HandlerRef | null {
  const dyn = branch.match(new RegExp(`\\{[^}]*\\b${esc(fn)}\\b[^}]*\\}\\s*=\\s*await\\s+import\\(\\s*['"]([^'"]+)['"]\\s*\\)`));
  if (dyn) return { fn, module: dyn[1] };
  const stat = indexSrc.match(new RegExp(`import\\s*\\{[^}]*\\b${esc(fn)}\\b[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`));
  return stat ? { fn, module: stat[1] } : null;
}

/** Type name of the handler's first parameter, or null when it is untyped / any. */
export function handlerInputType(moduleSrc: string, fn: string): string | null {
  const m = moduleSrc.match(new RegExp(`export\\s+(?:async\\s+)?function\\s+${esc(fn)}\\s*(?:<[^>]*>)?\\(\\s*\\w+\\??\\s*:\\s*([A-Za-z_$][\\w$]*)`))
    ?? moduleSrc.match(new RegExp(`export\\s+const\\s+${esc(fn)}\\s*=\\s*(?:async\\s*)?\\(\\s*\\w+\\??\\s*:\\s*([A-Za-z_$][\\w$]*)`));
  if (!m || ['any', 'unknown', 'object', 'Record'].includes(m[1])) return null;
  return m[1];
}

/** Top-level fields of `interface Name { ... }` (or `type Name = { ... }`), with the @internal ones. */
export function interfaceFields(src: string, name: string): InputFields | null {
  const head = src.match(new RegExp(`(?:interface\\s+${esc(name)}\\b[^{]*|type\\s+${esc(name)}\\s*=\\s*)\\{`));
  if (!head || head.index === undefined) return null;
  let i = head.index + head[0].length;
  let depth = 1;
  let body = '';
  for (; i < src.length && depth > 0; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (depth > 0) body += depth === 1 ? c : (c === '\n' ? '\n' : ' ');
  }
  const fields: string[] = [];
  const internal: string[] = [];
  let pendingDoc = '';
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t.startsWith('/**') || t.startsWith('*') || t.startsWith('//')) { pendingDoc += ` ${t}`; continue; }
    const f = t.match(/^(?:readonly\s+)?(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\??\s*:/);
    if (f) {
      const key = f[1] ?? f[2] ?? f[3];
      fields.push(key);
      if (/@internal\b/.test(pendingDoc)) internal.push(key);
    }
    if (t) pendingDoc = '';
  }
  return { fields, internal };
}

export function findInputDrift(tool: string, input: InputFields, schemaProps: string[]): string[] {
  return input.fields
    .filter(f => !input.internal.includes(f) && !schemaProps.includes(f))
    .map(f => `${tool}: input field '${f}' is missing from the MCP inputSchema`);
}

/** Resolves `fromFile` + a relative './x.js' import to the .ts source on disk. */
function sourceOf(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec).replace(/\.js$/, '');
  for (const c of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) if (fs.existsSync(c)) return c;
  return null;
}

/**
 * Finds the file that defines `name`, starting at `file` and following its relative imports and
 * re-exports (bounded depth).
 */
export function findTypeSource(file: string, name: string, depth = 3): { file: string; src: string } | null {
  const src = fs.readFileSync(file, 'utf8');
  if (interfaceFields(src, name)) return { file, src };
  if (depth === 0) return null;
  for (const m of src.matchAll(/(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*)\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const next = sourceOf(file, m[1]);
    if (!next) continue;
    const found = findTypeSource(next, name, depth - 1);
    if (found) return found;
  }
  return null;
}

/** Resolves the handler's own source file (following one re-export like `export { X } from './x.js'`). */
export function findHandlerSource(file: string, fn: string, depth = 2): { file: string; src: string } | null {
  const src = fs.readFileSync(file, 'utf8');
  if (handlerInputType(src, fn) !== null || new RegExp(`export\\s+(?:async\\s+)?function\\s+${esc(fn)}\\b|export\\s+const\\s+${esc(fn)}\\b`).test(src)) return { file, src };
  if (depth === 0) return null;
  // `export { fn } from './x.js'` names it; `export * from './x.js'` may contain it: try each.
  const named = src.match(new RegExp(`export\\s*\\{[^}]*\\b${esc(fn)}\\b[^}]*\\}\\s*from\\s*['"](\\.[^'"]+)['"]`));
  const candidates = named ? [named[1]] : [...src.matchAll(/export\s*\*\s*from\s*['"](\.[^'"]+)['"]/g)].map(m => m[1]);
  for (const spec of candidates) {
    const next = sourceOf(file, spec);
    const found = next ? findHandlerSource(next, fn, depth - 1) : null;
    if (found) return found;
  }
  return null;
}

/** Arg names a dispatch branch reads directly (`const { a, b = 1 } = args`, `args.a`, `(args as any).a`). */
export function branchArgReads(indexSrc: string, tool: string): string[] {
  const start = indexSrc.search(new RegExp(`name === '${esc(tool)}'`));
  if (start < 0) return [];
  const rest = indexSrc.slice(start);
  const next = rest.slice(1).search(/\}\s*else if \(name === '/);
  const branch = next >= 0 ? rest.slice(0, next + 1) : rest;
  const out = new Set<string>();
  for (const m of branch.matchAll(/const\s*\{([^}]*)\}\s*=\s*\(?\s*args\b/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/[\s=:]/)[0];
      if (name) out.add(name);
    }
  }
  for (const m of branch.matchAll(/\(?\s*args(?:\s+as\s+[^)]+\))?\s*\)?\.([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  return [...out];
}

/**
 * browser_tool params: every key of an action's zod `params` object must be read by its handler in
 * dispatch.ts, or be refused up front in src/browser/unsupported.ts. Otherwise the option is advertised
 * and silently ignored (the B5 finding).
 */
export function browserParamDrift(schemasSrc: string, dispatchSrc: string, unsupportedSrc: string): string[] {
  const problems: string[] = [];
  const actions = [...schemasSrc.matchAll(/^\s*([a-z_]+):\s*\{[\s\S]*?params:\s*z\.object\(\{([\s\S]*?)\}\)(?:\.passthrough\(\))?,?\s*$/gm)];
  const ignored = (action: string): string[] => {
    const block = unsupportedSrc.match(new RegExp(`\\b${esc(action)}:\\s*\\[([^\\]]*)\\]`));
    return block ? [...block[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : [];
  };
  for (const [, action, body] of actions) {
    const keys = [...body.matchAll(/(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*:\s*(?:waitSpec|z\.)/g)].map(m => m[1]);
    const handlerName = dispatchSrc.match(new RegExp(`case '${esc(action)}':\\s*return\\s+await\\s+(\\w+)\\(`))?.[1];
    if (!handlerName) continue; // handled elsewhere (e.g. before the switch) or not implemented (unsupported.ts refuses it)
    const fnStart = dispatchSrc.indexOf(`function ${handlerName}(`);
    if (fnStart < 0) continue;
    const nextFn = dispatchSrc.indexOf('\nasync function ', fnStart + 1);
    const body2 = dispatchSrc.slice(fnStart, nextFn > 0 ? nextFn : undefined);
    const reads = new Set<string>();
    for (const m of body2.matchAll(/const\s*\{([^}]*)\}\s*=\s*input\.params/g)) for (const p of m[1].split(',')) { const n = p.trim().split(/[\s=:]/)[0]; if (n) reads.add(n); }
    for (const m of body2.matchAll(/input\.params\??\.([A-Za-z_$][\w$]*)/g)) reads.add(m[1]);
    for (const m of body2.matchAll(/\(input\.params as any\)\.([A-Za-z_$][\w$]*)/g)) reads.add(m[1]);
    const refused = ignored(action);
    for (const k of keys) {
      if (!reads.has(k) && !refused.includes(k)) {
        problems.push(`browser_tool ${action}: param '${k}' is in the schema but its handler never reads it (implement it or list it in src/browser/unsupported.ts)`);
      }
    }
  }
  return problems;
}
