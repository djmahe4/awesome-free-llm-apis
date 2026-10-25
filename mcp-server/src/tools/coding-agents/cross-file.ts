/**
 * Cross-file context for a multi-file run. Each file is edited in its own model call; without this the
 * model never sees the other files, not even the signature it just changed in one of them (traced:
 * "I don't have the current content of src/money.js" while editing src/cart.js). Only the API surface is
 * shared (declaration and export lines), so the prompt stays small.
 */

const MAX_SURFACE_LINES = 40;

const DECLARATION = new RegExp([
  String.raw`^\s*(export\s+)?(default\s+)?(async\s+)?function\b`,
  String.raw`^\s*(export\s+)?(default\s+)?(abstract\s+)?class\b`,
  String.raw`^\s*(export\s+)?(interface|type|enum)\b`,
  String.raw`^\s*export\s+(const|let|var)\b`,
  String.raw`^\s*(module\.)?exports\b`,
  String.raw`^\s*(const|let|var)\s+\w+\s*=\s*(async\s*)?(\([^)]*\)|\w+)\s*=>`,
  String.raw`^\s*(const|let|var)\s+\{[^}]*\}\s*=\s*require\(`,
  String.raw`^\s*import\b`,
  // class members: "  name(args) {", "  async name(args) {", "  constructor(args) {"
  String.raw`^\s{2,}(static\s+)?(async\s+)?(get\s+|set\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(:\s*[^={]+)?\{\s*$`,
].join('|'));

const CONTROL = /^\s*(if|for|while|switch|catch|return|else)\b/;

/** Declaration and export lines of a source file, bounded. */
export function apiSurface(content: string): string {
  const lines = content.split(/\r?\n/).filter(l => DECLARATION.test(l) && !CONTROL.test(l)).map(l => l.trimEnd());
  return lines.slice(0, MAX_SURFACE_LINES).join('\n') + (lines.length > MAX_SURFACE_LINES ? `\n... (${lines.length - MAX_SURFACE_LINES} more)` : '');
}

/**
 * The block appended to one file's instruction: which file to edit now, and the other files' surfaces,
 * the ones edited earlier in this run in their NEW form.
 */
export function crossFileContext(current: string, files: string[], contents: Map<string, string>, edited: Set<string>): string {
  const others = files.filter(f => f !== current);
  if (others.length === 0) return '';
  const parts = others.map(f => {
    const surface = apiSurface(contents.get(f) ?? '');
    const state = edited.has(f) ? 'already edited in this run, current version' : 'not edited yet, will be edited after this file';
    return `--- ${f} (${state}) ---\n${surface || '(no declarations)'}`;
  });
  return `[Multi-file change] Edit only ${current} in this reply. The other files in this change, for reference (API surface only):\n${parts.join('\n')}`;
}
