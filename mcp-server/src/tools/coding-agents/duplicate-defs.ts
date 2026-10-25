/**
 * Duplicate definitions an edit introduced. Traced with the 7B on a Python task: instead of editing
 * `def invoice_line(item)` it added a second `def invoice_line(item, currency)` above it and left the
 * original below; the later definition wins, so the old signature kept overriding the new one for six
 * attempts. A second definition of an existing name is never what an edit of that name means, so it is
 * rejected with the reason and the retry edits the existing one.
 */

const JS_DEF = /^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?(function\*?|class)\s+([A-Za-z_$][\w$]*)/;
const PY_DEF = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/;

interface Def { name: string; line: number; indent: number; scope: string }

function definitions(src: string, filePath: string): Def[] {
  const py = /\.py$/i.test(filePath);
  const js = /\.(m|c)?[jt]sx?$/i.test(filePath);
  if (!py && !js) return [];
  const lines = src.split(/\r?\n/);
  const defs: Def[] = [];
  // enclosing class per indent level, so a method named x in class A and in class B is not a duplicate
  const classAt: Array<{ indent: number; name: string }> = [];
  lines.forEach((text, idx) => {
    const m = text.match(py ? PY_DEF : JS_DEF);
    if (!m) {
      if (js) return;
      return;
    }
    const indent = m[1].length;
    while (classAt.length && classAt[classAt.length - 1].indent >= indent) classAt.pop();
    const scope = classAt.map(c => c.name).join('.');
    const isClass = m[2] === 'class';
    if (isClass) classAt.push({ indent, name: m[3] });
    // TS overload signatures end with ';' and have no body; Python decorated defs (@property/@x.setter/@overload) repeat legitimately
    if (js && /;\s*$/.test(text) && !isClass) return;
    if (py) {
      const prev = idx > 0 ? lines[idx - 1].trim() : '';
      if (prev.startsWith('@')) return;
    }
    defs.push({ name: m[3], line: idx + 1, indent, scope });
  });
  return defs;
}

function duplicates(src: string, filePath: string): Map<string, number[]> {
  const seen = new Map<string, number[]>();
  for (const d of definitions(src, filePath)) {
    const key = `${d.scope}|${d.indent}|${d.name}`;
    seen.set(key, [...(seen.get(key) ?? []), d.line]);
  }
  return new Map([...seen].filter(([, lines]) => lines.length > 1));
}

/** One message per name the edit made defined twice (names already duplicated before the edit are ignored). */
export function newDuplicateDefinitions(filePath: string, before: string, after: string): string[] {
  const had = new Set([...duplicates(before, filePath).keys()]);
  const out: string[] = [];
  for (const [key, lines] of duplicates(after, filePath)) {
    if (had.has(key)) continue;
    const name = key.split('|')[2];
    out.push(`${filePath}: ${name} is defined twice (lines ${lines.join(' and ')}); the later definition replaces the earlier one. Edit the existing definition instead of adding a second one.`);
  }
  return out;
}
