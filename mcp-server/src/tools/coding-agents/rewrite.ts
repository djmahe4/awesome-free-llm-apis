import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import { hasCommand } from './lsp-actions.js';

// `__dirname` isn't a global in ESM (this package is "type": "module") — this
// file previously used it directly in getAstGrepCmd(), throwing a
// ReferenceError the instant that function ran, which crashed EVERY astEditOps
// call. Same fix/pattern server.ts already uses for its own __dirname. Note
// the module now lives one directory deeper (src/tools/coding-agents/), so
// package-root-relative paths in getAstGrepCmd() need an extra '..'.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Helpers ───────────────────────────────────────────────────────────────────

export function computeTag(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').substring(0, 8);
}

/**
 * Build a safe regex from an OMP-style `$$$VAR` pattern.
 * Three-step: placeholder → escape → restore wildcard.
 * Avoids the double-escape bug where .*? gets escaped after injection.
 *
 * NOTE: Real OMP uses ast-grep (structural AST) not regex.
 * This regex fallback is provided for simple text patterns only.
 * Limit to ONE `$$$` wildcard per pattern to avoid catastrophic backtracking.
 */
function buildPatternRegex(pat: string): { regex: RegExp; hasCapture: boolean } {
  const SENTINEL = '\x00__OAGENT_WC__\x00'; // unique enough to avoid collisions
  const hasCapture = /\$\$\$[A-Z0-9_]*/.test(pat);
  const normalizedPat = pat.replace(/\r\n/g, '\n');
  const processed = normalizedPat
    .replace(/\$\$\$[A-Z0-9_]*/g, SENTINEL)  // A: mark wildcards
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')  // B: escape specials
    .replace(/\n/g, '\\r?\\n')              // Handle CRLF / LF transparently
    .replace(/\x00__OAGENT_WC__\x00/g, '([\\s\\S]*?)'); // C: restore as capture group
  return { regex: new RegExp(processed, 'g'), hasCapture };
}

function applyPatternRewrite(content: string, pat: string, out: string): { content: string; matchCount: number } {
  const { regex, hasCapture } = buildPatternRegex(pat);
  const matches = content.match(regex);
  if (!matches || matches.length === 0) {
    return { content, matchCount: 0 };
  }
  regex.lastIndex = 0;

  // Extract wildcard names from pat to map them to capture group indices
  const patWildcards = Array.from(pat.matchAll(/\$\$\$[A-Z0-9_]*/g)).map(m => m[0]);

  // If out has $$$ wildcard reference, replace it with $1, $2, etc based on index in pat
  const targetOut = hasCapture
    ? out.replace(/\$\$\$[A-Z0-9_]*/g, (match) => {
        const idx = patWildcards.indexOf(match);
        return idx !== -1 ? `$${idx + 1}` : match;
      })
    : out;

  const replaced = content.replace(regex, targetOut);
  return { content: replaced, matchCount: matches.length };
}

function getAstGrepCmd(): string | null {
  // Check local project node_modules/.bin first
  const localCandidates = [
    path.resolve(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'ast-grep.cmd' : 'ast-grep'),
    path.resolve(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'sg.cmd' : 'sg'),
    path.resolve(__dirname, '..', '..', '..', 'node_modules', '.bin', process.platform === 'win32' ? 'ast-grep.cmd' : 'ast-grep'),
  ];
  for (const cand of localCandidates) {
    if (fs.existsSync(cand)) return cand;
  }

  if (hasCommand('ast-grep')) return 'ast-grep';
  if (hasCommand('sg')) return 'sg';

  if (process.platform === 'win32' && process.env.APPDATA) {
    const astGrepPath = path.join(process.env.APPDATA, 'npm', 'ast-grep.cmd');
    if (fs.existsSync(astGrepPath)) return astGrepPath;
    const sgPath = path.join(process.env.APPDATA, 'npm', 'sg.cmd');
    if (fs.existsSync(sgPath)) return sgPath;
  }
  return null;
}

function runAstGrepRewrite(
  content: string,
  pat: string,
  out: string,
  ext: string
): { content: string; matchCount: number } | null {
  const sgCmd = getAstGrepCmd();
  if (!sgCmd) return null;

  const langMap: Record<string, string> = {
    '.ts': 'ts',
    '.tsx': 'tsx',
    '.js': 'js',
    '.jsx': 'jsx',
    '.mjs': 'js',
    '.cjs': 'js',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.html': 'html',
    '.css': 'css',
    '.json': 'json',
    '.c': 'c',
    '.cpp': 'cpp',
  };
  const lang = langMap[ext];
  if (!lang) return null;

  try {
    const res = spawnSync(sgCmd, [
      'run',
      '--pattern', pat,
      '--rewrite', out,
      '--lang', lang,
      '--stdin',
    ], {
      input: content,
      encoding: 'utf-8',
      timeout: 10_000,
      windowsHide: true,
      shell: process.platform === 'win32',
    });

    if (res.status === 0 && res.stdout && res.stdout !== content) {
      const { regex } = buildPatternRegex(pat);
      const matchCount = (content.match(regex) || []).length || 1;
      return { content: res.stdout, matchCount };
    }
  } catch {
    // fallback to ts-morph / regex
  }
  return null;
}

/**
 * Multi-language structural AST rewrite:
 * 1. TS/JS files dispatched to in-memory ts-morph compiler AST.
 * 2. ast-grep CLI (@ast-grep/cli) for multi-language AST rewrites (Python, Rust, Go, HTML, CSS, C/C++).
 * 3. Fallback to safe regex pattern rewrite for general text/markup.
 */
export async function applyStructuralRewrite(
  filePath: string,
  content: string,
  pat: string,
  out: string
): Promise<{ content: string; matchCount: number }> {
  const ext = path.extname(filePath).toLowerCase();

  // 1. TS/JS AST Structural Rewrites via in-memory ts-morph compiler AST (clean full text output)
  if (/\.(ts|tsx|js|jsx)$/i.test(ext)) {
    try {
      const { Project } = await import('ts-morph');
      const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
      const src = project.createSourceFile(filePath, content, { overwrite: true });

      // Extract literal tokens, ignoring wildcards and syntax punctuation
      const tokens = pat.split(/\$\$\$[A-Z0-9_]*|[()[\]{},;.\s]+/).filter(Boolean);
      let matchCount = 0;

      src.forEachDescendant((node, traversal) => {
        const text = node.getText();
        const matchesTokens = tokens.length === 0 || tokens.every(token => text.includes(token));
        if (matchesTokens) {
            const rewritten = applyPatternRewrite(text, pat, out);
            if (rewritten.matchCount > 0 && rewritten.content !== text) {
              try {
                node.replaceWithText(rewritten.content);
                matchCount += rewritten.matchCount;
                traversal.skip();
              } catch (err: any) { console.warn("replaceWithText error:", err.message); }
            }
          }
        });

      if (matchCount > 0) {
        return { content: src.getFullText(), matchCount };
      }
    } catch (err: any) {
      console.warn('[coding_agents] ts-morph AST structural rewrite failed, falling back to regex:', err);
    }
  }

  // 2. ast-grep CLI (@ast-grep/cli) for multi-language AST rewrites (Python, Rust, Go, HTML, CSS, C/C++)
  const astGrepResult = runAstGrepRewrite(content, pat, out, ext);
  if (astGrepResult && astGrepResult.matchCount > 0) {
    return astGrepResult;
  }

  // 3. Fallback to safe pattern regex
  return applyPatternRewrite(content, pat, out);
}

/**
 * Generates genuine unified diff hunks with standard git-style `---`, `+++`, `@@ -start,orig +start,repl @@`,
 * line deletions (-), additions (+), and unchanged context lines.
 */
