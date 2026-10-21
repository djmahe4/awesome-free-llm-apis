/**
 * Pure parsers for dependency manifests. No I/O: the GitHub client feeds them raw file text.
 * Parsers are deliberately forgiving — a malformed manifest yields fewer dependencies, never a throw.
 */

export type Ecosystem = 'npm' | 'pypi' | 'go' | 'cargo';

export interface Dependency {
  name: string;
  ecosystem: Ecosystem;
  /** Version spec exactly as written in the manifest (may be a range). */
  spec?: string;
  dev?: boolean;
  /** Manifest the dependency came from. */
  source: string;
}

export interface ManifestInfo {
  file: string;
  ecosystem: Ecosystem;
  /** Package's own published name, when the manifest declares one. */
  packageName?: string;
  description?: string;
  dependencies: Dependency[];
}

export function parsePackageJson(file: string, text: string): ManifestInfo | null {
  let j: any;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const deps: Dependency[] = [];
  const add = (obj: unknown, dev: boolean) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [name, spec] of Object.entries(obj as Record<string, unknown>)) {
      deps.push({ name, ecosystem: 'npm', spec: typeof spec === 'string' ? spec : undefined, dev, source: file });
    }
  };
  add(j.dependencies, false);
  add(j.devDependencies, true);
  return {
    file, ecosystem: 'npm',
    packageName: typeof j.name === 'string' ? j.name : undefined,
    description: typeof j.description === 'string' ? j.description : undefined,
    dependencies: deps,
  };
}

/** PEP 508-ish requirement line → name + spec. */
function parseRequirement(line: string): { name: string; spec?: string } | null {
  const l = line.split('#')[0].trim();
  if (!l || l.startsWith('-') || /^(https?:|git\+|file:)/i.test(l)) return null;
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([^;]*)/.exec(l);
  if (!m) return null;
  const spec = m[2].trim();
  return { name: m[1], spec: spec || undefined };
}

export function parseRequirementsTxt(file: string, text: string): ManifestInfo {
  const dependencies: Dependency[] = [];
  for (const line of text.split(/\r?\n/)) {
    const r = parseRequirement(line);
    if (r) dependencies.push({ name: r.name, ecosystem: 'pypi', spec: r.spec, source: file });
  }
  return { file, ecosystem: 'pypi', dependencies };
}

/** Extracts the quoted strings of a TOML array body (single- or double-quoted). */
function quotedStrings(body: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.push(m[1] ?? m[2]);
  return out;
}

export function parsePyproject(file: string, text: string): ManifestInfo | null {
  if (!/\[(project|tool\.poetry)/.test(text)) return null;
  const dependencies: Dependency[] = [];
  const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text)?.[1];
  const description = /^\s*description\s*=\s*["']([^"']+)["']/m.exec(text)?.[1];
  // PEP 621: dependencies = [ "a>=1", ... ] (may span lines; stop at the closing bracket at line start-ish)
  const pep = /^dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(text);
  if (pep) {
    for (const s of quotedStrings(pep[1])) {
      const r = parseRequirement(s);
      if (r) dependencies.push({ name: r.name, ecosystem: 'pypi', spec: r.spec, source: file });
    }
  }
  // Poetry: [tool.poetry.dependencies] name = "^1.0" | { version = "..." }
  const poetry = /^\[tool\.poetry\.dependencies\]\s*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text);
  if (poetry) {
    for (const line of poetry[1].split(/\r?\n/)) {
      const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(.+)$/.exec(line.trim());
      if (!m || m[1].toLowerCase() === 'python') continue;
      const spec = /^["']([^"']+)["']/.exec(m[2])?.[1] ?? /version\s*=\s*["']([^"']+)["']/.exec(m[2])?.[1];
      dependencies.push({ name: m[1], ecosystem: 'pypi', spec, source: file });
    }
  }
  return { file, ecosystem: 'pypi', packageName: name, description, dependencies };
}

export function parseGoMod(file: string, text: string): ManifestInfo {
  const dependencies: Dependency[] = [];
  const module = /^module\s+(\S+)/m.exec(text)?.[1];
  const push = (line: string) => {
    const m = /^\s*(\S+)\s+(v\S+)(\s*\/\/\s*indirect)?/.exec(line);
    if (m) dependencies.push({ name: m[1], ecosystem: 'go', spec: m[2], dev: !!m[3], source: file });
  };
  const block = /^require\s*\(([\s\S]*?)^\)/gm;
  let b: RegExpExecArray | null;
  while ((b = block.exec(text))) b[1].split(/\r?\n/).forEach(push);
  for (const m of text.matchAll(/^require\s+(\S+\s+v\S+.*)$/gm)) push(m[1]);
  return { file, ecosystem: 'go', packageName: module, dependencies };
}

export function parseCargoToml(file: string, text: string): ManifestInfo | null {
  if (!/\[package\]|\[dependencies\]|\[workspace/.test(text)) return null;
  const dependencies: Dependency[] = [];
  const pkg = /^\[package\]\s*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text)?.[1] ?? '';
  const section = (title: string, dev: boolean) => {
    const re = new RegExp('^\\[' + title.replace('.', '\\.') + '\\]\\s*\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))', 'm');
    const body = re.exec(text)?.[1];
    if (!body) return;
    for (const line of body.split(/\r?\n/)) {
      const m = /^([A-Za-z0-9][A-Za-z0-9_-]*)\s*=\s*(.+)$/.exec(line.trim());
      if (!m) continue;
      const spec = /^["']([^"']+)["']/.exec(m[2])?.[1] ?? /version\s*=\s*["']([^"']+)["']/.exec(m[2])?.[1];
      dependencies.push({ name: m[1], ecosystem: 'cargo', spec, dev, source: file });
    }
  };
  section('dependencies', false);
  section('dev-dependencies', true);
  return {
    file, ecosystem: 'cargo',
    packageName: /^name\s*=\s*["']([^"']+)["']/m.exec(pkg)?.[1],
    description: /^description\s*=\s*["']([^"']+)["']/m.exec(pkg)?.[1],
    dependencies,
  };
}

/** Dispatch by file name; returns null for files we do not understand. */
export function parseManifest(path: string, text: string): ManifestInfo | null {
  const base = path.split('/').pop()!.toLowerCase();
  if (base === 'package.json') return parsePackageJson(path, text);
  if (base === 'pyproject.toml') return parsePyproject(path, text);
  if (base === 'go.mod') return parseGoMod(path, text);
  if (base === 'cargo.toml') return parseCargoToml(path, text);
  if (/^requirements.*\.txt$/.test(base)) return parseRequirementsTxt(path, text);
  return null;
}

export const MANIFEST_BASENAMES = /(^|\/)(package\.json|pyproject\.toml|go\.mod|Cargo\.toml|requirements[^/]*\.txt)$/i;
