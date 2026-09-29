/**
 * coding-agents.ts — OMP-style multi-file coding agent (v1.1.0)
 *
 * Pipeline (5 stages):
 *   1. Enumerate  — WorkspaceScanner lists all code files
 *   2. Locate     — VectorStore TF-IDF RAG picks topK relevant files
 *   3. Anchor     — SHA-256 content snapshot ([PATH#TAG] format)
 *   4. Edit       — AST structural rewrites + LLM generation (localLlmPatch)
 *   5. Verify     — OMP-style multi-language LSP dispatcher:
 *                   TS/JS → ts-morph getPreEmitDiagnostics (real pre-emit)
 *                   Python → python3 -c "import ast; ast.parse(...)" subprocess
 *                   Go    → go vet -json subprocess
 *                   Rust  → rustc --error-format json subprocess
 *
 * Research basis:
 *   - ts-morph: Context7 /dsherret/ts-morph — useInMemoryFileSystem, getPreEmitDiagnostics,
 *               DiagnosticCategory, getLineNumber, getMessageText, removeSourceFile
 *   - OMP: ast_edit uses ast-grep (structural AST rewrite, not regex);
 *          lsp action=diagnostics dispatches to real language servers
 *   - Multi-lang: Node.js child_process.spawnSync; go vet -json; rustc --error-format json;
 *                 python3 -c "import ast, sys; ast.parse(sys.stdin.read())"
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import { VectorStore, DocumentNode } from '../memory/VectorStore.js';
import { logToolCall } from '../utils/ChatLogger.js';
import { localLlmPatch } from './local-llm-patch.js';
import { RunRegistry, RunInfo } from '../pipeline/middlewares/RunRegistry.js';
import { globalCasStore, CheckpointManifest } from '../memory/ContentAddressableCheckpoint.js';

// `__dirname` isn't a global in ESM (this package is "type": "module") — this
// file previously used it directly in getAstGrepCmd(), throwing a
// ReferenceError the instant that function ran, which crashed EVERY astEditOps
// call (not just the local-node_modules candidate that referenced it) since
// it's evaluated eagerly as part of the candidates array literal. Same
// fix/pattern server.ts already uses for its own __dirname.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface SnapshotAnchor {
  filePath: string;
  hashTag: string; // [PATH#SHA8] e.g. "src/server.ts#a1b2c3d4"
  lineCount: number;
  capturedAt: number;
}

export interface LineAnchoredPatch {
  filePath: string;
  anchorTag: string;
  startLine: number;
  endLine: number;
  originalSnippet: string;   // preview (first 10 lines)
  replacementSnippet: string; // preview (first 10 lines)
  fullPatchedContent: string; // full content used for diagnostics & writes
  unifiedDiff: string;
  symbols?: string[];
  /** True if this file didn't exist before this run — used by the post-apply
   * rollback gate, since a CAS checkpoint only captures pre-existing content
   * and can't "restore" a file that never had a prior version. */
  isNewFile?: boolean;
}

export interface DiagnosticResult {
  filePath: string;
  line?: number;
  column?: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
  code?: number;
  source?: 'omp-lsp' | 'ast-syntactic' | 'semantic' | 'subprocess' | 'json-syntax' | 'llm-patch';
}

export interface LspActionRequest {
  action: 'diagnostics' | 'symbols' | 'definition' | 'references';
  file?: string;
  symbol?: string;
  query?: string;
}

export interface AstEditOp {
  /** OMP-style pattern, e.g. "console.log($$$MSG)" — single $$$ wildcard recommended */
  pat: string;
  /** Replacement, e.g. "logger.info($$$MSG)" */
  out: string;
}

export interface ResolveAction {
  action: 'apply' | 'discard' | 'rollback';
  checkpointId?: string;
  reason?: string;
}

export interface TaskItem {
  id: string;
  task: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  /** File this subtask targets — set by intelligent decomposition; naive fallback leaves it unset. */
  targetFile?: string;
  /** Why this file/subtask, constraints, dependencies on other subtasks — from the planner. */
  context?: string;
  /** Blackboard: append-only record of what actually happened each time this task was resumed
   * (files touched, model used, applied outcome, diagnostic count) — the AI-agent <-> local_llm_patch
   * interaction history, not just a checkbox. */
  log?: string[];
}

export interface CodingAgentsInput {
  goal: string;
  workspaceRoot?: string;
  targetFiles?: string[];
  dryRun?: boolean;
  topKFiles?: number;
  sessionId?: string;
  verifyLspDiagnostics?: boolean;
  lspAction?: LspActionRequest;
  astEditOps?: AstEditOp[];
  resolve?: ResolveAction;
  action?: 'plan' | 'execute' | 'resume' | 'status' | 'abort';
  pauseOnTaskPlan?: boolean;
}

export interface CodingAgentsResult {
  sessionId: string;
  goal: string;
  pipelineStage: 'enumerate' | 'locate' | 'anchor' | 'edit' | 'verify' | 'completed';
  relevantFiles: string[];
  anchors: SnapshotAnchor[];
  patchPlan: LineAnchoredPatch[];
  patchSummary: string;
  diagnostics: DiagnosticResult[];
  applied: boolean;
  status?: 'applied' | 'rollback' | 'dry_run' | 'paused' | 'running';
  message?: string;
  checkpointId?: string;
  restoredFiles?: string[];
  astRewritesCount?: number;
  markdown?: string;
  content?: string;
  error?: string;
  tasksPlan?: TaskItem[];
  tasksFile?: string;
  isPaused?: boolean;
  modelUsed?: string;
  usedFallbackModel?: boolean;
  wiringFiles?: string[];
  wiringContext?: string[];
}

export function formatCodingAgentsMarkdown(result: CodingAgentsResult): string {
  if (result.error) {
    return `### 🤖 Coding Agent Error\n\n**Error:** ${result.error}\n\n${result.pipelineStage ? `_Pipeline Stage: \`${result.pipelineStage}\`_` : ''}`;
  }

  const lines: string[] = [];
  const statusLabel = result.status === 'running'
    ? '⏳ Running in Background'
    : result.status === 'paused'
    ? '⏸️ Workflow Paused (tasks.md)'
    : (result.applied ? '✅ Changes Applied to Disk' : (result.patchPlan?.length ? '🔍 Proposed Plan (Dry Run)' : '⚡ Execution Completed'));
  lines.push(`### 🤖 Coding Agent: ${statusLabel}\n`);
  lines.push(`- **Goal:** ${result.goal}`);
  lines.push(`- **Pipeline Stage:** \`${result.pipelineStage || 'completed'}\``);
  if (result.checkpointId) {
    lines.push(`- **CAS Checkpoint:** \`${result.checkpointId}\``);
  }
  if (result.modelUsed) {
    lines.push(`- **Model Used:** \`${result.modelUsed}\`${result.usedFallbackModel ? ' _(cloud fallback)_' : ''}`);
  }
  if (result.relevantFiles?.length) {
    lines.push(`- **Target Files:** ${result.relevantFiles.map(f => `\`${f}\``).join(', ')}`);
  }
  if (result.wiringFiles?.length) {
    lines.push(`- **Discovered Wiring Targets:** ${result.wiringFiles.map(f => `\`${f}\``).join(', ')}`);
  }
  if (result.anchors?.length) {
    lines.push(`- **Anchors:** ${result.anchors.map(a => `\`${a.hashTag}\``).join(', ')}`);
  }
  if (result.astRewritesCount) {
    lines.push(`- **AST Structural Rewrites:** ${result.astRewritesCount}`);
  }
  if (result.tasksPlan?.length) {
    const doneCount = result.tasksPlan.filter(t => t.status === 'completed').length;
    lines.push(`\n#### 📋 Tasks DAG (${doneCount}/${result.tasksPlan.length} completed)`);
    for (const t of result.tasksPlan) {
      const check = t.status === 'completed' ? '[x]' : (t.status === 'in_progress' ? '[~]' : '[ ]');
      lines.push(`- ${check} \`${t.id}\`: ${t.task}`);
    }
  }
  if (result.isPaused) {
    lines.push(`\n> ⏸️ **Workflow Paused**: \`${result.tasksFile || 'tasks.md'}\` created. Pass \`action: "resume"\` to execute next pending task.`);
  }

  const actionableDiagnostics = (result.diagnostics || []).filter(
    d => d.severity !== 'info' || !d.message.toLowerCase().includes('skipped')
  );
  if (actionableDiagnostics.length) {
    lines.push(`\n#### 🩺 Diagnostics (${actionableDiagnostics.length})`);
    for (const d of actionableDiagnostics) {
      const icon = d.severity === 'error' ? '❌' : (d.severity === 'warning' ? '⚠️' : 'ℹ️');
      const loc = d.filePath ? `\`${d.filePath}${d.line ? `:${d.line}` : ''}\`` : '';
      lines.push(`- ${icon} **${d.severity.toUpperCase()}** ${loc}: ${d.message}`);
    }
  }

  if (result.patchPlan?.length) {
    lines.push(`\n#### 📝 Patches (${result.patchPlan.length} file${result.patchPlan.length > 1 ? 's' : ''})`);
    for (const p of result.patchPlan) {
      lines.push(`\n##### \`${p.filePath}\` (${p.anchorTag || 'diff'})`);
      const diffContent = p.unifiedDiff || (p.replacementSnippet ? `@@ -${p.startLine} +${p.startLine} @@\n${p.replacementSnippet}` : '');
      if (diffContent) {
        lines.push('```diff');
        lines.push(diffContent.trim());
        lines.push('```');
      }
    }
  } else if (result.patchSummary) {
    lines.push('\n#### 📝 Patch Summary');
    lines.push('```diff');
    lines.push(result.patchSummary.trim());
    lines.push('```');
  }

  return lines.join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeTag(content: string): string {
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
    path.resolve(__dirname, '..', '..', 'node_modules', '.bin', process.platform === 'win32' ? 'ast-grep.cmd' : 'ast-grep'),
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
async function applyStructuralRewrite(
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
function generateUnifiedDiff(
  relPath: string,
  hashTag: string,
  originalLines: string[],
  patchedLines: string[],
  maxDiffLines = 100
): { unifiedDiff: string; origSnippet: string; replSnippet: string; startLine: number } {
  // 1. Identify common prefix and common suffix
  let prefix = 0;
  while (
    prefix < originalLines.length &&
    prefix < patchedLines.length &&
    originalLines[prefix] === patchedLines[prefix]
  ) {
    prefix++;
  }

  let origSuffix = originalLines.length - 1;
  let patchSuffix = patchedLines.length - 1;
  while (
    origSuffix >= prefix &&
    patchSuffix >= prefix &&
    originalLines[origSuffix] === patchedLines[patchSuffix]
  ) {
    origSuffix--;
    patchSuffix--;
  }

  // Context padding (3 lines of context around change)
  const contextPad = 3;
  const origStart = Math.max(0, prefix - contextPad);
  const origEnd = Math.min(originalLines.length, origSuffix + 1 + contextPad);
  const patchStart = Math.max(0, prefix - contextPad);
  const patchEnd = Math.min(patchedLines.length, patchSuffix + 1 + contextPad);

  const origCount = origEnd - origStart;
  const patchCount = patchEnd - patchStart;
  const startLine = origStart + 1;

  const hunkLines: string[] = [];
  hunkLines.push(`--- ${relPath} ${hashTag}`);
  hunkLines.push(`+++ ${relPath} (proposed)`);
  hunkLines.push(`@@ -${startLine},${origCount} +${patchStart + 1},${patchCount} @@`);

  // Leading context
  for (let i = origStart; i < prefix; i++) {
    hunkLines.push(` ${originalLines[i]}`);
  }

  // Deleted lines from original
  const delCount = origSuffix - prefix + 1;
  if (delCount > 0) {
    if (delCount > maxDiffLines) {
      for (let i = prefix; i < prefix + 15; i++) {
        hunkLines.push(`-${originalLines[i]}`);
      }
      hunkLines.push(`- ... [${delCount - 25} lines omitted] ...`);
      for (let i = origSuffix - 9; i <= origSuffix; i++) {
        hunkLines.push(`-${originalLines[i]}`);
      }
    } else {
      for (let i = prefix; i <= origSuffix; i++) {
        hunkLines.push(`-${originalLines[i]}`);
      }
    }
  }

  // Added lines in patch
  const addCount = patchSuffix - prefix + 1;
  if (addCount > 0) {
    if (addCount > maxDiffLines) {
      for (let i = prefix; i < prefix + 15; i++) {
        hunkLines.push(`+${patchedLines[i]}`);
      }
      hunkLines.push(`+ ... [${addCount - 25} lines omitted] ...`);
      for (let i = patchSuffix - 9; i <= patchSuffix; i++) {
        hunkLines.push(`+${patchedLines[i]}`);
      }
    } else {
      for (let i = prefix; i <= patchSuffix; i++) {
        hunkLines.push(`+${patchedLines[i]}`);
      }
    }
  }

  // Trailing context
  for (let i = origSuffix + 1; i < origEnd; i++) {
    hunkLines.push(` ${originalLines[i]}`);
  }

  const origSnippet = originalLines.slice(origStart, origEnd).join('\n');
  const replSnippet = patchedLines.slice(patchStart, patchEnd).join('\n');

  return {
    unifiedDiff: hunkLines.join('\n') + '\n',
    origSnippet,
    replSnippet,
    startLine,
  };
}

/**
 * Computes a target-anchored sliding window snippet instead of a naive slice(0, 10).
 * Centers preview around the first modification line while preserving header context.
 */
function computeWindowedSnippet(
  originalLines: string[],
  patchedLines: string[],
  windowSize = 12
): { origSnippet: string; replSnippet: string; startLine: number } {
  // Find first modified line (1-indexed)
  let diffLine = 1;
  const maxL = Math.max(originalLines.length, patchedLines.length);
  for (let i = 0; i < maxL; i++) {
    if (originalLines[i] !== patchedLines[i]) {
      diffLine = i + 1;
      break;
    }
  }

  const half = Math.floor(windowSize / 2);
  const startLine = Math.max(1, diffLine - half);
  const origSnippet = originalLines.slice(startLine - 1, startLine - 1 + windowSize).join('\n');
  const replSnippet = patchedLines.slice(startLine - 1, startLine - 1 + windowSize).join('\n');

  return { origSnippet, replSnippet, startLine };
}

/** Assert path is inside workspaceRoot to prevent path traversal on writes. */
function assertSafe(fullPath: string, workspaceRoot: string): void {
  const normalized = path.resolve(fullPath);
  const root = path.resolve(workspaceRoot);
  if (!normalized.startsWith(root + path.sep) && normalized !== root) {
    throw new Error(`[security] Path traversal blocked: ${normalized} is outside ${root}`);
  }
}

// ── Multi-language LSP Dispatcher ─────────────────────────────────────────────
// OMP uses real language servers (pyright, gopls, rust-analyzer).
// We use subprocess validators as a lightweight equivalent:
//   Python → python3 ast.parse (syntax only)
//   Go     → go vet -json (static analysis)
//   Rust   → rustc --error-format json (compiler errors)
//   TS/JS  → ts-morph getPreEmitDiagnostics (syntactic + semantic)

function getPythonCmd(): string | null {
  for (const cmd of ['python', 'python3']) {
    try {
      const res = spawnSync(cmd, ['--version'], { encoding: 'utf-8', timeout: 3000, windowsHide: true });
      if (res.status === 0) return cmd;
    } catch { /* try next */ }
  }
  return null;
}

function runPythonAstCheck(filePath: string, content: string): DiagnosticResult[] {
  const pyCmd = getPythonCmd();
  if (!pyCmd) return [];

  const script = `
import ast, sys, json
try:
    ast.parse(sys.stdin.read(), filename=${JSON.stringify(path.basename(filePath))})
    print("[]")
except SyntaxError as e:
    print(json.dumps([{"line": e.lineno, "col": e.offset, "msg": str(e.msg)}]))
except Exception as e:
    print(json.dumps([{"line": 1, "col": 1, "msg": str(e)}]))
`;

  const result = spawnSync(pyCmd, ['-c', script], {
    input: content,
    encoding: 'utf-8',
    timeout: 10_000,
    windowsHide: true,
  });

  if (result.error || !result.stdout) return [];

  try {
    const parsed: Array<{ line?: number; col?: number; msg: string }> = JSON.parse(result.stdout || '[]');
    return parsed.map(d => ({
      filePath,
      line: d.line,
      column: d.col,
      message: d.msg,
      severity: 'error' as const,
      source: 'subprocess' as const,
    }));
  } catch {
    return [];
  }
}

function runGoVetCheck(filePath: string, workspaceRoot: string): DiagnosticResult[] {
  const dir = path.dirname(path.resolve(workspaceRoot, filePath));
  const result = spawnSync('go', ['vet', './...'], {
    cwd: dir,
    encoding: 'utf-8',
    timeout: 30_000,
  });

  const diags: DiagnosticResult[] = [];
  if (result.error || result.status === 0) return diags;

  const stderr = result.stderr?.toString() || '';
  const regex = /^(.+?):(\d+):(\d+): (.+)$/gm;
  let m: RegExpExecArray | null;

  while ((m = regex.exec(stderr)) !== null) {
    diags.push({
      filePath: path.resolve(dir, m[1]),
      line: parseInt(m[2], 10),
      column: parseInt(m[3], 10),
      message: m[4],
      severity: 'error',
      source: 'subprocess',
    });
  }
  return diags;
}

function runRustcCheck(filePath: string, content: string): DiagnosticResult[] {
  // Write to a temp file — rustc requires a real file path
  const tmpFile = `${filePath}.oagent.tmp.rs`;
  try {
    require('fs').writeFileSync(tmpFile, content, 'utf-8');
    const result = spawnSync('rustc', ['--edition', '2021', '--error-format', 'json', tmpFile], {
      encoding: 'utf-8',
      timeout: 30_000,
    });
    require('fs').unlinkSync(tmpFile);

    const diags: DiagnosticResult[] = [];
    const lines = (result.stderr || '').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.$message_type === 'diagnostic') {
          const span = obj.spans?.[0];
          diags.push({
            filePath,
            line: span?.line_start,
            column: span?.column_start,
            message: obj.message || 'Unknown Rust error',
            severity: obj.level === 'error' ? 'error' : 'warning',
            source: 'subprocess',
          });
        }
      } catch { /* skip */ }
    }
    return diags;
  } catch {
    try { require('fs').unlinkSync(tmpFile); } catch { /* ignore */ }
    return [];
  }
}

async function runTsMorphCheck(
  filePath: string,
  fullContent: string
): Promise<DiagnosticResult[]> {
  const diags: DiagnosticResult[] = [];
  try {
    const { Project, DiagnosticCategory } = await import('ts-morph');
    // New project per file — avoids cross-file type leakage ("duplicate identifier" false positives)
    // Context7 ref: /dsherret/ts-morph — useInMemoryFileSystem, skipAddingFilesFromTsConfig
    const project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        // skipLibCheck: suppress false positives from missing node_modules declarations
        // (in-memory FS has no lib.d.ts; only syntactic + basic semantic checks work)
        skipLibCheck: true,
        strict: false, // avoid noise from strict null checks on snippets
      },
    });

    const srcFile = project.createSourceFile(filePath, fullContent, { overwrite: true });

    // Context7: sourceFile.getPreEmitDiagnostics() — syntactic + semantic, global, options
    const diagnostics = srcFile.getPreEmitDiagnostics();

    for (const diag of diagnostics) {
      // Context7: diag.getLineNumber(), diag.getCategory(), diag.getMessageText(), diag.getCode()
      const cat = diag.getCategory();
      const severity: 'error' | 'warning' | 'info' =
        cat === DiagnosticCategory.Error   ? 'error' :
        cat === DiagnosticCategory.Warning ? 'warning' :
        'info';

      diags.push({
        filePath,
        line: diag.getLineNumber(),
        message: diag.getMessageText().toString(),
        severity,
        code: diag.getCode(),
        source: 'ast-syntactic',
      });
    }

    // Extract exported symbols via forEachDescendant
    // Context7: node.forEachDescendant(node => ...) — visitor pattern
    return diags;
  } catch (err: any) {
    console.warn(`[coding-agents] ts-morph check failed for ${filePath}: ${err.message}`);
    return diags;
  }
}

async function extractTsMorphSymbols(
  filePath: string,
  fullContent: string
): Promise<string[]> {
  try {
    const { Project, SyntaxKind } = await import('ts-morph');
    const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
    const srcFile = project.createSourceFile(filePath, fullContent, { overwrite: true });

    const symbols: string[] = [];
    // Context7: forEachDescendant for visitor pattern across all descendants
    srcFile.forEachDescendant(node => {
      const kind = node.getKind();
      if (
        kind === SyntaxKind.FunctionDeclaration ||
        kind === SyntaxKind.ClassDeclaration ||
        kind === SyntaxKind.InterfaceDeclaration ||
        kind === SyntaxKind.TypeAliasDeclaration ||
        kind === SyntaxKind.EnumDeclaration ||
        kind === SyntaxKind.VariableDeclaration
      ) {
        const nameable = node as any;
        if (typeof nameable.getName === 'function') {
          const name = nameable.getName();
          if (typeof name === 'string' && name.length > 0) symbols.push(name);
        }
      }
    });

    return Array.from(new Set(symbols));
  } catch {
    return [];
  }
}

// ── OMP-style LSP Action Dispatcher ──────────────────────────────────────────

async function dispatchLspDiagnostics(
  patch: LineAnchoredPatch,
  workspaceRoot: string
): Promise<DiagnosticResult[]> {
  const ext = path.extname(patch.filePath).toLowerCase();
  const content = patch.fullPatchedContent;

  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(ext)) {
    return runTsMorphCheck(patch.filePath, content);
  }

  if (ext === '.py') {
    const result = runPythonAstCheck(patch.filePath, content);
    if (result.length === 0 && !getPythonCmd()) {
      return [{
        filePath: patch.filePath,
        message: 'python/python3 not found in PATH — Python AST check skipped',
        severity: 'info',
        source: 'omp-lsp',
      }];
    }
    return result;
  }

  if (ext === '.go') {
    if (!hasCommand('go')) {
      return [{
        filePath: patch.filePath,
        message: 'go not found in PATH — Go vet check skipped',
        severity: 'info',
        source: 'omp-lsp',
      }];
    }
    return runGoVetCheck(patch.filePath, workspaceRoot);
  }

  if (ext === '.rs') {
    if (!hasCommand('rustc')) {
      return [{
        filePath: patch.filePath,
        message: 'rustc not found in PATH — Rust compiler check skipped',
        severity: 'info',
        source: 'omp-lsp',
      }];
    }
    return runRustcCheck(patch.filePath, content);
  }

  if (ext === '.json') {
    try {
      JSON.parse(content);
      return [];
    } catch (err: any) {
      let line = 1;
      const match = err?.message?.match(/position (\d+)/i);
      if (match) {
        const pos = parseInt(match[1], 10);
        line = content.slice(0, pos).split('\n').length;
      }
      return [{
        filePath: patch.filePath,
        line,
        message: `JSON syntax error: ${err.message || String(err)}`,
        severity: 'error',
        source: 'json-syntax',
      }];
    }
  }

  // Non-code documentation, markup, and config files: clean skip, no LSP noise
  if (/\.(md|markdown|txt|rst|yaml|yml|toml|ini|env|csv|html|htm|css|scss|less|svg|xml)$/.test(ext)) {
    return [];
  }

  // Unknown extension — cleanly skip without diagnostic clutter
  return [];
}

function hasCommand(cmd: string): boolean {
  try {
    const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      encoding: 'utf-8',
      timeout: 3_000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function decomposeGoalToTasks(goal: string): TaskItem[] {
  const lines = goal.split('\n').map(l => l.trim()).filter(Boolean);
  const listMarker = /^\s*(?:\d+[.)\-]|[-*])\s+/;
  const items: string[] = [];
  for (const line of lines) {
    // Only lines actually PREFIXED with a numbered/bulleted marker count as
    // separate items — a plain prose line (e.g. an intro sentence before the
    // numbered list) previously fell through .replace() unchanged and still
    // got pushed as its own bogus task, since replace() on a non-match is a
    // no-op, not a skip. Observed live: a goal like "Do these N fixes:\n1. ..."
    // produced N+1 tasks, the intro line becoming a fabricated task-1.
    if (!listMarker.test(line)) continue;
    const clean = line.replace(listMarker, '').trim();
    if (clean) items.push(clean);
  }
  const taskStrings = items.length >= 2 ? items : [goal];
  return taskStrings.map((task, idx) => ({
    id: `task-${idx + 1}`,
    task,
    status: 'pending' as const,
    log: [],
  }));
}

/**
 * LLM-driven subtask decomposition. Uses the cloud model (useFreeLLM), not the
 * local coder model — this is a planning/reasoning task, and the local model
 * (already proven weak at multi-file/architectural reasoning elsewhere in this
 * pipeline) is the wrong tool for it.
 *
 * Two-phase, not one LLM call that both splits AND annotates:
 *   Phase 1 (deterministic): if the goal is already an explicit enumerated
 *     list (numbered/bulleted lines, >=2 items), extract those items VERBATIM
 *     via decomposeGoalToTasks — plain text parsing, zero hallucination risk.
 *     The LLM never gets a chance to drop, reorder, or invent items when the
 *     caller already told us exactly what they are.
 *   Phase 2 (LLM, annotation-only): ask the model only to fill in
 *     targetFile/context for that FIXED list, one line per index, and
 *     validate the response has exactly the same number of entries in the
 *     same order before trusting any of it — a malformed or wrong-length
 *     response is discarded wholesale rather than partially applied,
 *     falling back to un-annotated tasks (still the full correct set).
 * Only when the goal is a single unstructured paragraph (no explicit list)
 * does the LLM get to propose the task breakdown itself — genuinely
 * ambiguous input has no safe deterministic alternative.
 *
 * Observed live: a goal with 5 explicitly numbered subtasks, decomposed via
 * the old single-call approach, came back with 2 of the 5 dropped and 2
 * unrelated ones invented in their place — this two-phase split exists
 * specifically to make that failure mode structurally impossible for any
 * goal that already enumerates its own subtasks.
 */
async function decomposeGoalIntelligently(
  goal: string,
  workspaceRoot: string,
  candidateFiles: string[],
  sessionId: string,
): Promise<TaskItem[]> {
  const naiveTasks = decomposeGoalToTasks(goal);
  const goalIsExplicitlyEnumerated = naiveTasks.length >= 2;

  if (goalIsExplicitlyEnumerated) {
    return await annotateFixedTaskList(naiveTasks, workspaceRoot, candidateFiles, sessionId);
  }

  try {
    const { useFreeLLM } = await import('./use-free-llm.js');
    const fileList = candidateFiles.slice(0, 60).join('\n');
    const prompt = [
      `Break the following goal into an ordered list of small, independent subtasks, one per file that needs to change.`,
      `Return ONLY a JSON array, no prose, no code fence, no explanation. Each element:`,
      `{ "task": "<imperative, self-contained instruction for this one subtask>", "targetFile": "<relative path from the candidate list, omit if this subtask has no single target file>", "context": "<1-3 sentences: why this file, what it must respect or not break, dependencies on other subtasks>" }`,
      `If the goal is already a single small single-file change, return a single-element array.`,
      `## Goal\n${goal}`,
      `## Candidate files in this workspace (pick from these when possible)\n${fileList || '(none enumerated)'}`,
    ].join('\n\n');

    const res = await useFreeLLM({
      messages: [
        { role: 'system', content: 'You are a senior engineer decomposing a coding goal into an execution plan. Output strict JSON only.' },
        { role: 'user', content: prompt },
      ],
      taskType: 'reasoning',
      workspace_root: workspaceRoot,
      sessionId,
      isOnePass: true,
      skipIndexing: true,
    } as any);

    const raw = res?.choices?.[0]?.message?.content || (res as any)?.content || (typeof res === 'string' ? res : '');
    if (!raw || typeof raw !== 'string') throw new Error('Empty planner response');

    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('Planner response contained no JSON array');
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Planner returned an empty/invalid array');

    const tasks: TaskItem[] = parsed
      .map((item: any, idx: number): TaskItem => ({
        id: `task-${idx + 1}`,
        task: String(item?.task || '').trim(),
        status: 'pending' as const,
        targetFile: item?.targetFile ? path.normalize(String(item.targetFile).trim()).replace(/\\/g, '/') : undefined,
        context: item?.context ? String(item.context).trim() : undefined,
        log: [],
      }))
      .filter(t => t.task.length > 0);

    if (tasks.length === 0) throw new Error('Planner returned no usable tasks');
    return tasks;
  } catch (err: any) {
    console.warn(`[coding-agents] Intelligent decomposition failed, falling back to naive split: ${err.message}`);
    return naiveTasks;
  }
}

/** Phase 2 of decomposeGoalIntelligently: annotate an already-fixed task list
 * with targetFile/context, without letting the LLM change the list itself. */
async function annotateFixedTaskList(
  tasks: TaskItem[],
  workspaceRoot: string,
  candidateFiles: string[],
  sessionId: string,
): Promise<TaskItem[]> {
  try {
    const { useFreeLLM } = await import('./use-free-llm.js');
    const fileList = candidateFiles.slice(0, 60).join('\n');
    const taskList = tasks.map((t, i) => `${i}: ${t.task}`).join('\n');
    const prompt = [
      `These ${tasks.length} subtasks are already fixed and final — do not add, remove, reorder, merge, or reword any of them.`,
      `For EACH one, in the same order, provide only its target file and short context.`,
      `Return ONLY a JSON array of exactly ${tasks.length} elements, no prose, no code fence. Element i corresponds to subtask i:`,
      `{ "targetFile": "<relative path from the candidate list, or null if this subtask has no single target file>", "context": "<1-3 sentences: why this file, what it must respect or not break, dependencies on other subtasks>" }`,
      `## Fixed subtasks (index: text)\n${taskList}`,
      `## Candidate files in this workspace (pick from these when possible)\n${fileList || '(none enumerated)'}`,
    ].join('\n\n');

    const res = await useFreeLLM({
      messages: [
        { role: 'system', content: 'You annotate an already-decided task list with file/context metadata only. You never change the list itself. Output strict JSON only.' },
        { role: 'user', content: prompt },
      ],
      taskType: 'reasoning',
      workspace_root: workspaceRoot,
      sessionId,
      isOnePass: true,
      skipIndexing: true,
    } as any);

    const raw = res?.choices?.[0]?.message?.content || (res as any)?.content || (typeof res === 'string' ? res : '');
    if (!raw || typeof raw !== 'string') throw new Error('Empty annotator response');

    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('Annotator response contained no JSON array');
    const parsed = JSON.parse(jsonMatch[0]);
    // Wrong length is discarded wholesale, not zipped partially — a
    // mismatched-length response means the model didn't follow the fixed-list
    // constraint and can't be trusted to have kept index alignment either.
    if (!Array.isArray(parsed) || parsed.length !== tasks.length) {
      throw new Error(`Annotator returned ${Array.isArray(parsed) ? parsed.length : 'non-array'}, expected exactly ${tasks.length}`);
    }

    return tasks.map((t, i) => {
      const ann = parsed[i];
      return {
        ...t,
        targetFile: ann?.targetFile ? path.normalize(String(ann.targetFile).trim()).replace(/\\/g, '/') : undefined,
        context: ann?.context ? String(ann.context).trim() : undefined,
      };
    });
  } catch (err: any) {
    console.warn(`[coding-agents] Task annotation failed, using un-annotated (but complete and correct) task list: ${err.message}`);
    return tasks;
  }
}

export function serializeTasksMarkdown(goal: string, tasks: TaskItem[]): string {
  const firstLine = goal.split('\n')[0].replace(/^#+\s*/, '');
  const lines = [`# Tasks Plan: ${firstLine}\n`];
  for (const t of tasks) {
    const check = t.status === 'completed' ? '[x]' : (t.status === 'in_progress' ? '[~]' : '[ ]');
    lines.push(`- ${check} [${t.id}] ${t.task}`);
    if (t.targetFile) lines.push(`  - file: ${t.targetFile}`);
    if (t.context) lines.push(`  - context: ${t.context}`);
    if (t.log && t.log.length > 0) {
      lines.push(`  - log:`);
      for (const entry of t.log) lines.push(`    - ${entry}`);
    }
  }
  return lines.join('\n');
}

/** Parses tasks.md back, including the per-task file/context metadata and the
 * blackboard log — a simple line-state-machine since each task can span
 * several indented lines, not just its own checkbox line. */
export function parseTasksMarkdown(content: string): TaskItem[] {
  const lines = content.split(/\r?\n/);
  const tasks: TaskItem[] = [];
  let current: TaskItem | null = null;
  let inLog = false;
  for (const line of lines) {
    const taskMatch = line.match(/^-\s*\[([ xX~])\]\s*(?:\[([^\]]+)\])?\s*(.+)$/);
    if (taskMatch) {
      const mark = taskMatch[1].toLowerCase();
      const status: TaskItem['status'] = mark === 'x' ? 'completed' : (mark === '~' ? 'in_progress' : 'pending');
      const id = taskMatch[2] || `task-${tasks.length + 1}`;
      const task = taskMatch[3].trim();
      current = { id, task, status, log: [] };
      tasks.push(current);
      inLog = false;
      continue;
    }
    if (!current) continue;
    const fileMatch = line.match(/^\s{2}-\s*file:\s*(.+)$/);
    if (fileMatch) { current.targetFile = fileMatch[1].trim(); inLog = false; continue; }
    const contextMatch = line.match(/^\s{2}-\s*context:\s*(.+)$/);
    if (contextMatch) { current.context = contextMatch[1].trim(); inLog = false; continue; }
    if (/^\s{2}-\s*log:\s*$/.test(line)) { inLog = true; continue; }
    const logEntryMatch = line.match(/^\s{4}-\s*(.+)$/);
    if (inLog && logEntryMatch) {
      (current.log ??= []).push(logEntryMatch[1].trim());
      continue;
    }
  }
  return tasks;
}

/** Recovers the original plan goal recorded in a tasks.md header, so resume calls don't overwrite it with a per-task or stale `input.goal`. */
export function extractGoalFromTasksMarkdown(content: string): string | undefined {
  const match = content.match(/^#\s*Tasks Plan:\s*(.+)$/m);
  return match ? match[1].trim() : undefined;
}

function extractCodeBlock(text: string): string {
  const fenced = text.match(/```(?:[a-zA-Z0-9_+-]*)\r?\n([\s\S]*?)```/);
  if (fenced) return fenced[1];
  // No closing fence found (truncated cloud response) — regex above needs
  // BOTH fences to match at all, so an unclosed opening fence previously fell
  // through to returning `text` completely unstripped, leaving a literal
  // "```\n<!DOCTYPE html>..." at the top of the applied file. Strip a leading
  // opening-fence line on its own even with no matching close.
  const openOnly = text.match(/^```[a-zA-Z0-9_+-]*\r?\n([\s\S]*)$/);
  return openOnly ? openOnly[1] : text;
}

/**
 * Sliding-window context extractor for large non-module files (HTML, classic JS).
 * Scores each line by how many instruction terms it contains, then returns
 * the best ~120-line window + the surrounding line indices so the caller can
 * splice the patched window back into the full content.
 * Returns null when the file is small enough to send whole.
 */
export function extractWindowForInstruction(
  content: string,
  instruction: string,
  windowSize = 120
): { window: string; startIdx: number; endIdx: number; lineCount: number } | null {
  const lines = content.split(/\r?\n/);
  if (lines.length <= windowSize) return null;

  const terms = (instruction.match(/\b[a-zA-Z][a-zA-Z0-9_-]{4,}\b/g) ?? [])
    .map(t => t.toLowerCase());
  const uniqueTerms = [...new Set(terms)].slice(0, 12);

  const perLineScore = lines.map(line => {
    const lower = line.toLowerCase();
    return uniqueTerms.filter(t => lower.includes(t)).length;
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
  let bestScore = -1;
  let bestLine = Math.floor(lines.length / 2);
  for (let i = 0; i < lines.length; i++) {
    let windowScore = 0;
    for (let j = Math.max(0, i - neighborhood); j <= Math.min(lines.length - 1, i + neighborhood); j++) {
      windowScore += perLineScore[j];
    }
    if (windowScore > bestScore) { bestScore = windowScore; bestLine = i; }
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
function windowReplyIsSuspicious(originalWindowLines: string[], replyLines: string[]): boolean {
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

function parseSearchReplaceBlocks(text: string): SearchReplaceBlock[] {
  const blocks: SearchReplaceBlock[] = [];
  const re = /<{5,}\s*SEARCH\r?\n([\s\S]*?)\r?\n={5,}\r?\n([\s\S]*?)\r?\n>{5,}\s*REPLACE/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    blocks.push({ search: m[1], replace: m[2] });
  }
  return blocks;
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

  return { index: -1, ambiguous: false, usedLineNumberStrip: false };
}

export function applySearchReplaceBlocks(
  content: string,
  blocks: SearchReplaceBlock[]
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
    if (!search) {
      failures.push('Empty SEARCH block (nothing to match)');
      continue;
    }
    if (STRAY_MARKER_RE.test(search) || STRAY_MARKER_RE.test(replace)) {
      failures.push('Block contains a stray SEARCH/REPLACE marker line (malformed/nested response) — not applied');
      continue;
    }
    const searchLines = search.split(/\r?\n/);
    const { index, ambiguous, usedLineNumberStrip } = findLineBlockMatch(workingLines, searchLines);
    if (index === -1) {
      failures.push(`SEARCH text not found (even with whitespace-tolerant matching): ${JSON.stringify(search.slice(0, 80))}${search.length > 80 ? '…' : ''}`);
    } else if (ambiguous) {
      failures.push(`SEARCH text matched multiple times (ambiguous, must be unique): ${JSON.stringify(search.slice(0, 80))}${search.length > 80 ? '…' : ''}`);
    } else {
      // If the match only succeeded after stripping a bogus "L<N>: " prefix
      // from SEARCH, the model very likely echoed the same annotation into
      // REPLACE too (observed live, symmetric on both sides of the block) —
      // strip it there as well, or the "fix" would insert that literal
      // presentation-only text into the real file.
      const replaceLines = (usedLineNumberStrip ? replace.replace(new RegExp(LINE_NUMBER_PREFIX_RE.source, 'gm'), '') : replace).split(/\r?\n/);
      workingLines = [
        ...workingLines.slice(0, index),
        ...replaceLines,
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
async function searchReplaceRegressesTsErrors(
  filePath: string,
  beforeContent: string,
  afterContent: string
): Promise<boolean> {
  if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(filePath)) return false;
  const countErrors = (diags: DiagnosticResult[]) => diags.filter(d => d.severity === 'error').length;
  const [before, after] = await Promise.all([
    runTsMorphCheck(filePath, beforeContent),
    runTsMorphCheck(filePath, afterContent),
  ]);
  return countErrors(after) > countErrors(before);
}

function looksLikeHallucinatedReplacement(originalContent: string, patchedContent: string): boolean {
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
async function generateSearchReplacePatch(
  currentContent: string,
  instruction: string,
  filename: string,
  tasksContext: string | undefined,
  chat: (prompt: string) => Promise<string>
): Promise<{ content: string; appliedCount: number; failures: string[]; hardFailure?: string }> {
  const hasExports = /^\s*export\s+/m.test(currentContent);
  const windowInfo = !hasExports ? extractWindowForInstruction(currentContent, instruction) : null;
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
      'Rules: SEARCH text must match the shown content exactly and must be unique (usually 1–5 lines — include just enough surrounding text to make it unambiguous). Do not paraphrase or reformat SEARCH text. Emit multiple blocks if the instruction requires edits in more than one place.',
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

  const blocks = parseSearchReplaceBlocks(raw);
  if (blocks.length === 0) {
    return { content: currentContent, appliedCount: 0, failures: [], hardFailure: 'No SEARCH/REPLACE blocks found in response' };
  }

  const { content, appliedCount, failures } = applySearchReplaceBlocks(currentContent, blocks);
  return { content, appliedCount, failures };
}

async function generateCodePatchWithCloudLLM(
  filePath: string,
  instruction: string,
  currentContent: string,
  workspaceRoot: string,
  sessionId: string,
  tasksContext?: string
): Promise<{ patch: string | null; failureReason?: string }> {
  try {
    const { useFreeLLM } = await import('./use-free-llm.js');
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

async function discoverWiringTargets(
  newFilePath: string,
  workspaceRoot: string,
  sessionId: string
): Promise<{ wiringFiles: string[]; snippets: string[] }> {
  try {
    const { ContextGatherer } = await import('../pipeline/middlewares/context-gatherer.js');
    const parentDir = path.dirname(newFilePath);
    const parentBasename = path.basename(parentDir);
    const fileBase = path.basename(newFilePath, path.extname(newFilePath));

    const query = `${parentBasename} ${fileBase} import`;
    const snippets = await ContextGatherer.gatherContext({
      workspaceRoot,
      query,
      limit: 5,
      sessionId,
    });

    const wiringFiles: string[] = [];
    const filePattern = /\[Context\]\s*---\s*FILE:\s*([^\s-]+)\s*---/g;
    for (const snippet of snippets) {
      let m: RegExpExecArray | null;
      while ((m = filePattern.exec(snippet)) !== null) {
        const foundPath = m[1].replace(/\\/g, '/');
        if (
          foundPath !== newFilePath &&
          !wiringFiles.includes(foundPath) &&
          !foundPath.includes('docs/') &&
          !foundPath.endsWith('.md')
        ) {
          wiringFiles.push(foundPath);
        }
      }
    }

    // Check parent barrel export (index.ts / index.js)
    const fullParent = path.resolve(workspaceRoot, parentDir);
    for (const barrelName of ['index.ts', 'index.js']) {
      const fullBarrel = path.join(fullParent, barrelName);
      const barrelRel = path.relative(workspaceRoot, fullBarrel).replace(/\\/g, '/');
      if (barrelRel !== newFilePath && (await fs.pathExists(fullBarrel))) {
        if (!wiringFiles.includes(barrelRel)) wiringFiles.unshift(barrelRel);
      }
    }

    return { wiringFiles, snippets };
  } catch (err: any) {
    console.warn(`[coding-agents] Wiring discovery skipped: ${err.message}`);
    return { wiringFiles: [], snippets: [] };
  }
}

async function scanCodeFiles(dir: string, maxFiles = 100): Promise<string[]> {
  const result: string[] = [];
  const queue = [dir];
  const SKIP = new Set([
    'node_modules', '.git', 'dist', 'build', '.venv', 'venv', '.cache', 'coverage',
    'docs', 'documentation', 'site', 'specs', 'man', 'manual', 'wiki', 'notes', '.github', '.agents'
  ]);
  const EXT = /\.(ts|js|tsx|jsx|mjs|cjs|json|py|go|rs|c|cpp|h|hpp|java|cs|rb|php|swift|kt)$/i;

  while (queue.length > 0 && result.length < maxFiles) {
    const current = queue.shift()!;
    try {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink() || SKIP.has(entry.name.toLowerCase())) continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          queue.push(full);
        } else if (entry.isFile() && EXT.test(entry.name)) {
          const rel = path.relative(dir, full).replace(/\\/g, '/');
          result.push(rel);
          if (result.length >= maxFiles) break;
        }
      }
    } catch {
      // Ignore unreadable dirs
    }
  }
  return result;
}

// ── Main Handler ──────────────────────────────────────────────────────────────

// Background pipeline runs, keyed by sessionId — non-dry-run execution can involve
// local/cloud LLM patch generation over several files, and a large prompt can
// legitimately take a long time to produce a large diff. Rather than impose a hard
// timeout (which would kill valid slow work), a real (non-dry-run) run executes
// off the request/response path and callers poll with action:'status', mirroring
// use_free_llm's run/continue/status/abort pattern (RunRegistry.ts). dry_run
// previews, plan creation, and rollback stay synchronous — they're fast and
// callers expect an immediate result.
const codingAgentsResultsCache = new Map<string, CodingAgentsResult>();

function withMarkdown(result: CodingAgentsResult): CodingAgentsResult {
  result.content = formatCodingAgentsMarkdown(result);
  result.markdown = result.content;
  return result;
}

export async function CodingAgentsHandler(input: CodingAgentsInput): Promise<CodingAgentsResult> {
  const sessionId = input.sessionId || `omp-${Date.now()}`;
  const runKey = `coding_agents:${sessionId}`;

  if (input.action === 'status') {
    const run = RunRegistry.get(runKey);
    if (!run) {
      return withMarkdown({
        sessionId, goal: input.goal, pipelineStage: 'completed', relevantFiles: [], anchors: [],
        patchPlan: [], patchSummary: '', diagnostics: [], applied: false,
        error: `No run found for sessionId '${sessionId}'. Call with action:"execute" (dryRun:false) first.`,
      });
    }
    if (!run.done) {
      return withMarkdown({
        sessionId, goal: input.goal, pipelineStage: 'edit', relevantFiles: [], anchors: [],
        patchPlan: [], patchSummary: '', diagnostics: [], applied: false,
        status: 'running',
        message: `Running: ${run.completedCount}/${run.totalCount} file(s) (last: ${run.lastSubtask || 'n/a'})`,
      });
    }
    return codingAgentsResultsCache.get(runKey) || withMarkdown({
      sessionId, goal: input.goal, pipelineStage: 'completed', relevantFiles: [], anchors: [],
      patchPlan: [], patchSummary: '', diagnostics: [], applied: false,
      error: 'Run finished but no cached result was found.',
    });
  }

  if (input.action === 'abort') {
    const aborted = RunRegistry.abort(runKey);
    return withMarkdown({
      sessionId, goal: input.goal, pipelineStage: 'completed', relevantFiles: [], anchors: [],
      patchPlan: [], patchSummary: '', diagnostics: [], applied: false,
      status: 'running',
      message: aborted ? 'Abort requested; in-flight file patching will stop after its current file.' : `No active run found for sessionId '${sessionId}' to abort.`,
    });
  }

  const dryRun = input.dryRun !== false; // same default as the pipeline itself
  const isRollback = input.resolve?.action === 'rollback';
  const isPlanOnly = input.action === 'plan' || input.pauseOnTaskPlan;
  // astEditOps-only edits are deterministic structural rewrites — the pipeline itself
  // skips LLM generation entirely for them (see the `!input.astEditOps` guard in Step 4),
  // so there's nothing slow here to background.
  const isAstOnly = !!input.astEditOps && input.astEditOps.length > 0;

  // Fast, synchronous paths: preview, plan creation, rollback, deterministic AST edits — unchanged behavior.
  if (dryRun || isRollback || isPlanOnly || isAstOnly) {
    return runCodingAgentsPipeline(input, sessionId);
  }

  // Real execution: background it so a slow local-model generation over a large
  // prompt can't be mistaken for a hang by the caller's own tool-call timeout.
  const existingRun = RunRegistry.get(runKey);
  if (existingRun && !existingRun.done) {
    return withMarkdown({
      sessionId, goal: input.goal, pipelineStage: 'edit', relevantFiles: [], anchors: [],
      patchPlan: [], patchSummary: '', diagnostics: [], applied: false,
      status: 'running',
      message: `Already running: ${existingRun.completedCount}/${existingRun.totalCount} file(s). Poll with action:"status" and the same sessionId.`,
    });
  }

  const run = RunRegistry.start(runKey);
  (async () => {
    try {
      const result = await runCodingAgentsPipeline(input, sessionId, run);
      codingAgentsResultsCache.set(runKey, result);
      RunRegistry.finish(runKey, result.error);
    } catch (err: any) {
      codingAgentsResultsCache.set(runKey, withMarkdown({
        sessionId, goal: input.goal, pipelineStage: 'completed', relevantFiles: [], anchors: [],
        patchPlan: [], patchSummary: '', diagnostics: [], applied: false,
        error: err?.message || String(err),
      }));
      RunRegistry.finish(runKey, err?.message || String(err));
    }
  })();

  return withMarkdown({
    sessionId, goal: input.goal, pipelineStage: 'edit', relevantFiles: [], anchors: [],
    patchPlan: [], patchSummary: '', diagnostics: [], applied: false,
    status: 'running',
    message: `Started coding_agents execution in the background. Poll with action:"status" and the same sessionId.`,
  });
}

async function runCodingAgentsPipeline(input: CodingAgentsInput, sessionId: string, run?: RunInfo): Promise<CodingAgentsResult> {
  const start = Date.now();
  const workspaceRoot = path.resolve(input.workspaceRoot || process.cwd());
  const dryRun = input.dryRun !== false; // safe default: true
  const topK = input.topKFiles || 5;

  let result: CodingAgentsResult = {
    sessionId,
    goal: input.goal,
    pipelineStage: 'enumerate',
    relevantFiles: [],
    anchors: [],
    patchPlan: [],
    patchSummary: '',
    diagnostics: [],
    applied: false,
  };

  try {
    // ── Handle Rollback Action ───────────────────────────────────────────────
    if (input.resolve?.action === 'rollback') {
      const targetCheckpoint = input.resolve.checkpointId ||
        globalCasStore.listSessionCheckpoints(sessionId).pop()?.checkpointId;

      if (!targetCheckpoint) {
        throw new Error(`No CAS checkpoint found for session '${sessionId}' to rollback to.`);
      }

      const { restoredCount, files } = await globalCasStore.restoreCheckpointToDisk(
        targetCheckpoint,
        workspaceRoot
      );

      result.pipelineStage = 'completed';
      result.applied = true;
      result.status = 'rollback';
      result.checkpointId = targetCheckpoint;
      result.restoredFiles = files;
      result.patchSummary = `Rolled back ${restoredCount} file(s) from CAS checkpoint ${targetCheckpoint}`;
      return result;
    }

    if (!input.goal) throw new Error('Goal is required for coding_agents planning');

    const tasksFilePath = path.join(workspaceRoot, 'tasks.md');

    // ── Handle Action: 'plan' or pauseOnTaskPlan ─────────────────────────────
    if (input.action === 'plan' || input.pauseOnTaskPlan) {
      const planCandidateFiles = await scanCodeFiles(workspaceRoot, 100);
      const tasks = await decomposeGoalIntelligently(input.goal, workspaceRoot, planCandidateFiles, sessionId);
      await fs.writeFile(tasksFilePath, serializeTasksMarkdown(input.goal, tasks), 'utf-8');
      result.pipelineStage = 'completed';
      result.tasksPlan = tasks;
      result.tasksFile = 'tasks.md';
      result.isPaused = true;
      result.status = 'paused';
      result.patchSummary = `Created tasks.md with ${tasks.length} task(s) and paused. Call with action="resume" to proceed.`;
      result.content = formatCodingAgentsMarkdown(result);
      result.markdown = result.content;
      return result;
    }

    let activeGoal = input.goal;
    let loadedTasks: TaskItem[] | undefined;
    let nextPendingTask: TaskItem | undefined;
    let planGoal = input.goal;
    let taskResumeCount = 0;

    // ── Handle Action: 'resume' ──────────────────────────────────────────────
    if (input.action === 'resume') {
      if (await fs.pathExists(tasksFilePath)) {
        const tasksContent = await fs.readFile(tasksFilePath, 'utf-8');
        loadedTasks = parseTasksMarkdown(tasksContent);
        planGoal = extractGoalFromTasksMarkdown(tasksContent) || input.goal;
        nextPendingTask = loadedTasks.find(t => t.status === 'pending');
        if (nextPendingTask) {
          taskResumeCount = (nextPendingTask.log?.length || 0) + 1;
          nextPendingTask.status = 'in_progress';
          // Blackboard: fold the planner's own context (why this file, what
          // not to break, cross-task dependencies) into what local_llm_patch
          // actually sees, not just the bare task string.
          activeGoal = nextPendingTask.context
            ? `${nextPendingTask.task}\n\n[Planner context]\n${nextPendingTask.context}`
            : nextPendingTask.task;
        }
      }
    }

    // A planner-assigned targetFile scopes this resume to that one file, same
    // as an explicit input.targetFiles — but input.targetFiles (if the caller
    // passed one) always wins.
    const effectiveTargetFiles = (input.targetFiles && input.targetFiles.length > 0)
      ? input.targetFiles
      : (nextPendingTask?.targetFile ? [nextPendingTask.targetFile] : undefined);

    // ── Step 1: Enumerate ────────────────────────────────────────────────────
    const codeFiles: string[] = await scanCodeFiles(workspaceRoot, 100);

    // ── Step 2: Locate (VectorStore RAG) ────────────────────────────────────
    result.pipelineStage = 'locate';
    const store = new VectorStore();
    const docNodes: DocumentNode[] = [];

    for (const relPath of codeFiles) {
      try {
        const fullPath = path.resolve(workspaceRoot, relPath);
        if (await fs.pathExists(fullPath)) {
          const content = await fs.readFile(fullPath, 'utf-8');
          docNodes.push({ id: relPath, text: content });
        }
      } catch { /* Skip unreadable files */ }
    }

    if (effectiveTargetFiles && effectiveTargetFiles.length > 0) {
      result.relevantFiles = effectiveTargetFiles.map(f => path.normalize(f).replace(/\\/g, '/'));
    } else {
      await store.index(docNodes);
      const searchMatches = await store.query(activeGoal, topK);
      const matchedPaths = searchMatches.map(m => m.id);
      result.relevantFiles = matchedPaths.length > 0 ? matchedPaths : codeFiles.slice(0, topK);
    }

    // ── Step 2b: Automatic Wiring Discovery for New Files ────────────────────
    const discoveredWiring: string[] = [];
    const wiringSnippets: string[] = [];

    for (const relPath of result.relevantFiles) {
      const fullPath = path.resolve(workspaceRoot, relPath);
      if (!(await fs.pathExists(fullPath))) {
        const { wiringFiles, snippets } = await discoverWiringTargets(relPath, workspaceRoot, sessionId);
        discoveredWiring.push(...wiringFiles);
        wiringSnippets.push(...snippets);
      }
    }

    if (discoveredWiring.length > 0) {
      result.wiringFiles = Array.from(new Set(discoveredWiring));
      result.wiringContext = wiringSnippets;
    }

    // ── Step 3: Anchor [PATH#SHA8] ───────────────────────────────────────────
    result.pipelineStage = 'anchor';
    const anchors: SnapshotAnchor[] = [];
    const patches: LineAnchoredPatch[] = [];

    // Hoist model resolution — avoid N×listLocalModels HTTP calls (one per file)
    let resolvedModel: string | null = null;
    if (!dryRun) {
      try {
        const { listLocalModels, rankCandidateModels } = await import('../providers/ollama-local.js');
        const models = await listLocalModels();
        const ranked = rankCandidateModels(models);
        resolvedModel = ranked[0] ?? null;
      } catch {
        console.warn('[coding-agents] Ollama unreachable — will route to cloud model fallback');
      }
    }

    // ── Step 4: Edit (AST rewrites + LLM generation) ─────────────────────────
    result.pipelineStage = 'edit';
    if (run) run.totalCount = result.relevantFiles.length;
    // Blackboard tracking: did any file in this resume fail to produce a real
    // patch (LLM generation failure or hallucinated-replacement guard)? Used
    // to decide whether the task actually completed or should stay pending
    // for another resume attempt.
    let taskHadFailure = false;

    for (const relPath of result.relevantFiles) {
      if (run?.controller.signal.aborted) break;
      if (run) RunRegistry.progress(`coding_agents:${sessionId}`, relPath, run.completedCount, run.totalCount);
      const fullPath = path.resolve(workspaceRoot, relPath);
      assertSafe(fullPath, workspaceRoot); // security: block path traversal

      const fileExists = await fs.pathExists(fullPath);
      const originalContent = fileExists ? await fs.readFile(fullPath, 'utf-8') : '';
      const lines = originalContent ? originalContent.split('\n') : [];
      const tag = computeTag(originalContent);
      const hashTag = `[${relPath}#${tag}]`;

      anchors.push({
        filePath: relPath,
        hashTag,
        lineCount: lines.length,
        capturedAt: Date.now(),
      });

      let patchedContent = originalContent;
      let rewrites = 0;

      // 4a. LLM generation via localLlmPatch with seamless cloud fallback
      if (!dryRun && (!input.astEditOps || input.astEditOps.length === 0)) {
        let appliedPatch = false;
        let lastFailureReason: string | undefined;

        // Compose DAG task context string if tasks exist
        const tasksContext = loadedTasks
          ? `Active Task: [${nextPendingTask?.id || 'adhoc'}] ${activeGoal}\nOverall Plan:\n` +
            loadedTasks.map(t => `- [${t.status === 'completed' ? 'x' : (t.status === 'in_progress' ? '~' : ' ')}] ${t.task}`).join('\n')
          : undefined;

        const augmentedInstruction = tasksContext
          ? `${activeGoal}\n\n[DAG Context]\n${tasksContext}`
          : activeGoal;

        // Try SEARCH/REPLACE first, local model then cloud — see
        // generateSearchReplacePatch: unchanged content never passes through
        // the model, so it can't be collapsed/duplicated/hallucinated the
        // way full-file or windowed-splice replies can. Only fall through to
        // those older (guarded, but strictly weaker) strategies if no block
        // parses or every block fails to match — e.g. the model ignores the
        // requested format entirely.
        if (resolvedModel) {
          try {
            // Routed through localLlmPatch (not a direct chatLocal call) so
            // this shares the exact same model-invocation, context-gathering,
            // and refusal-detection code as the full-content path below —
            // including the same test/mock seam.
            const hasExports = /^\s*export\s+/m.test(patchedContent);
            const windowInfo = !hasExports ? extractWindowForInstruction(patchedContent, augmentedInstruction) : null;
            const srLlmResult = await localLlmPatch({
              filePath: fullPath,
              instruction: augmentedInstruction,
              workspace_root: workspaceRoot,
              sessionId,
              outputFormat: 'search-replace',
              contentOverride: windowInfo ? windowInfo.window : patchedContent,
              excerptRange: windowInfo
                ? { startLine: windowInfo.startIdx + 1, endLine: windowInfo.endIdx, totalLines: windowInfo.lineCount }
                : undefined,
            });
            if (srLlmResult.success && srLlmResult.patch?.trim()) {
              const blocks = parseSearchReplaceBlocks(srLlmResult.patch);
              if (blocks.length === 0) {
                lastFailureReason = `Local model (${resolvedModel}) SEARCH/REPLACE: no blocks found in response`;
              } else {
                // Apply against the FULL current content by exact text match —
                // independent of whatever window was shown to the model, so
                // there's no line-offset bookkeeping to get wrong.
                const { content, appliedCount, failures } = applySearchReplaceBlocks(patchedContent, blocks);
                const regressed = appliedCount > 0 && await searchReplaceRegressesTsErrors(relPath, patchedContent, content);
                if (appliedCount > 0 && !regressed) {
                  patchedContent = content;
                  result.modelUsed = resolvedModel;
                  result.usedFallbackModel = false;
                  appliedPatch = true;
                  if (failures.length > 0) {
                    result.diagnostics.push({
                      filePath: relPath,
                      message: `Local model (${resolvedModel}) SEARCH/REPLACE: ${appliedCount} block(s) applied, ${failures.length} skipped: ${failures.join('; ')}`,
                      severity: 'warning',
                      source: 'llm-patch',
                    });
                  }
                } else if (regressed) {
                  lastFailureReason = `Local model (${resolvedModel}) SEARCH/REPLACE: ${appliedCount} block(s) matched, but applying them increases the file's compiler error count — rejected atomically (partial async/signature migrations are worse than no change)`;
                } else {
                  lastFailureReason = `Local model (${resolvedModel}) SEARCH/REPLACE: no blocks applied (${failures.join('; ') || 'unknown reason'})`;
                }
              }
            } else if (srLlmResult.error) {
              lastFailureReason = `Local model (${resolvedModel}) SEARCH/REPLACE: ${srLlmResult.error}`;
            }
          } catch (srErr: any) {
            lastFailureReason = `Local model (${resolvedModel}) SEARCH/REPLACE failed: ${srErr.message}`;
          }
        }

        // Fall back to the older full-file / windowed-splice strategy —
        // weaker (relies on post-hoc corruption guards rather than making
        // corruption structurally impossible) but kept as a second attempt
        // in case the model can't/won't follow the SEARCH/REPLACE format.
        // The corruption guard runs on ITS result immediately — not after
        // the fact — because a local "success" that's actually a
        // hallucinated replacement must NOT skip the cloud fallback below
        // the way a genuine success would. Without this, a local model that
        // reliably produces garbage (rather than erroring) would set
        // appliedPatch=true and permanently starve cloud fallback of ever
        // being tried, forcing identical failures on every manual resume
        // retry instead of auto-escalating within one call.
        if (resolvedModel && !appliedPatch) {
          // Visible record that SEARCH/REPLACE failed and the pipeline is
          // dropping to a strategy that can't structurally prevent scope
          // drift — observed live: SR failed here (a vision-language model
          // wrongly entered the candidate pool, see rankCandidateModels),
          // full-file regen "fixed" the reported compile errors but also
          // silently renamed/deleted methods the goal never asked to touch.
          // The corruption guards below catch wholesale hallucination, not
          // this — a real, syntactically valid, but scope-violating rewrite.
          // Folded into lastFailureReason (rather than a separate diagnostic
          // entry) so it surfaces in the single final diagnostic if this
          // fallback also fails, matching this function's existing
          // localReason-chaining style instead of adding a second entry.
          const srFailureNote = lastFailureReason;
          lastFailureReason = undefined;
          try {
            // Same sliding-window fix already used for the cloud fallback below:
            // asking a local model to reproduce a large non-module file (HTML,
            // classic browser JS with no `export`s) in full is what causes
            // truncation/hallucination. Locate the ~120-line region the
            // instruction actually targets and send only that; local_llm_patch
            // splices nothing itself, so the excerpt is spliced back here,
            // right before the corruption guard runs on the reconstructed
            // full content — matching the cloud path's guard timing exactly.
            const hasExports = /^\s*export\s+/m.test(patchedContent);
            const windowInfo = !hasExports ? extractWindowForInstruction(patchedContent, activeGoal) : null;
            const llmResult = await localLlmPatch({
              filePath: fullPath,
              instruction: augmentedInstruction,
              workspace_root: workspaceRoot,
              sessionId,
              contentOverride: windowInfo ? windowInfo.window : undefined,
              excerptRange: windowInfo
                ? { startLine: windowInfo.startIdx + 1, endLine: windowInfo.endIdx, totalLines: windowInfo.lineCount }
                : undefined,
            });
            if (llmResult.success && llmResult.patch?.trim()) {
              const replyLines = llmResult.patch.split(/\r?\n/);
              const fullLines = patchedContent.split(/\r?\n/);
              const originalWindowLines = windowInfo ? fullLines.slice(windowInfo.startIdx, windowInfo.endIdx) : [];
              const windowMangled = windowInfo && windowReplyIsSuspicious(originalWindowLines, replyLines);
              const candidatePatch = windowInfo
                ? [
                    ...fullLines.slice(0, windowInfo.startIdx),
                    ...replyLines,
                    ...fullLines.slice(windowInfo.endIdx),
                  ].join('\n')
                : llmResult.patch;
              if (windowMangled) {
                lastFailureReason = `Local model (${resolvedModel}) mangled a ${originalWindowLines.length}-line excerpt instead of reproducing it verbatim (duplicated/dropped/reordered lines) — not used`;
              } else if (originalContent && looksLikeHallucinatedReplacement(originalContent, candidatePatch)) {
                lastFailureReason = `Local model (${resolvedModel}) produced a full-file replacement with no trace of the original file's content — likely hallucinated, not used`;
              } else {
                patchedContent = candidatePatch;
                result.modelUsed = resolvedModel;
                result.usedFallbackModel = false;
                appliedPatch = true;
              }
            } else if (llmResult.error) {
              lastFailureReason = `Local model (${resolvedModel}) failed: ${llmResult.error}`;
            }
          } catch (llmErr: any) {
            lastFailureReason = `Local model (${resolvedModel}) failed: ${llmErr.message}`;
            console.warn(`[coding-agents] ${lastFailureReason}`);
          }
          if (!appliedPatch && srFailureNote) {
            lastFailureReason = `SEARCH/REPLACE attempt failed (${srFailureNote}); full-file fallback also failed: ${lastFailureReason || 'unknown reason'}`;
          }
        }

        // If local model was unavailable, errored, or produced a hallucinated
        // result, fall back to cloud model — same guard applied to its output.
        if (!appliedPatch) {
          const localReason = lastFailureReason;

          // Same SEARCH/REPLACE attempt as the local model above, tried
          // first on cloud too, before falling back to full-file/windowed
          // generation — a stronger cloud model is more likely to follow
          // the format correctly, and success here is unconditionally safe
          // (unchanged content never passed through the model).
          try {
            const { useFreeLLM } = await import('./use-free-llm.js');
            const srResult = await generateSearchReplacePatch(
              patchedContent,
              activeGoal,
              relPath,
              tasksContext,
              async (prompt) => {
                const res = await useFreeLLM({
                  messages: [
                    { role: 'system', content: 'You are a precise code-editing assistant. Reply with ONLY the requested SEARCH/REPLACE blocks.' },
                    { role: 'user', content: prompt },
                  ],
                  keywords: ['coding', 'qwen', 'deepseek', 'codellama', 'coder'],
                  taskType: 'coding',
                  workspace_root: workspaceRoot,
                  sessionId,
                  isOnePass: true,
                  skipIndexing: true,
                });
                return res?.choices?.[0]?.message?.content || (res as any)?.content || (typeof res === 'string' ? res : '');
              }
            );
            const cloudRegressed = srResult.appliedCount > 0
              && await searchReplaceRegressesTsErrors(relPath, patchedContent, srResult.content);
            if (srResult.appliedCount > 0 && !cloudRegressed) {
              patchedContent = srResult.content;
              result.modelUsed = 'cloud-free-llm';
              result.usedFallbackModel = true;
              appliedPatch = true;
              if (srResult.failures.length > 0) {
                result.diagnostics.push({
                  filePath: relPath,
                  message: `Cloud model SEARCH/REPLACE: ${srResult.appliedCount} block(s) applied, ${srResult.failures.length} skipped: ${srResult.failures.join('; ')}`,
                  severity: 'warning',
                  source: 'llm-patch',
                });
              }
            } else if (cloudRegressed) {
              lastFailureReason = `Cloud model SEARCH/REPLACE: ${srResult.appliedCount} block(s) matched, but applying them increases the file's compiler error count — rejected atomically`;
            }
          } catch {
            // Fall through to the older cloud strategy below regardless of why.
          }
        }

        if (!appliedPatch) {
          const localReason = lastFailureReason;
          const { patch: cloudPatch, failureReason } = await generateCodePatchWithCloudLLM(
            fullPath,
            activeGoal,
            patchedContent,
            workspaceRoot,
            sessionId,
            tasksContext
          );
          if (cloudPatch?.trim() && originalContent && looksLikeHallucinatedReplacement(originalContent, cloudPatch)) {
            lastFailureReason = `${localReason ? `${localReason} ` : ''}Cloud fallback also produced a full-file replacement with no trace of the original file's content — likely hallucinated, not used`;
          } else if (cloudPatch?.trim()) {
            patchedContent = cloudPatch;
            result.modelUsed = 'cloud-free-llm';
            result.usedFallbackModel = true;
            appliedPatch = true;
          } else {
            // If local model specifically failed/refused, surface that primary reason
            lastFailureReason = localReason
              ? `${localReason} (Cloud fallback also failed: ${failureReason || 'no response'})`
              : (failureReason || 'No valid code patch produced by LLM');
          }
        }

        if (!appliedPatch && lastFailureReason) {
          taskHadFailure = true;
          result.diagnostics.push({
            filePath: relPath,
            message: `${lastFailureReason}. You can continue by re-running coding_agents with action: "resume" or providing astEditOps.`,
            severity: 'error',
            source: 'llm-patch',
          });
        }
      }

      // 4b. Structural AST rewrites (OMP-style $$$VAR patterns)
      if (input.astEditOps && input.astEditOps.length > 0) {
        for (const op of input.astEditOps) {
          const { content: rewritten, matchCount } = await applyStructuralRewrite(fullPath, patchedContent, op.pat, op.out);
          if (matchCount > 0) {
            patchedContent = rewritten;
            rewrites += matchCount;
          } else {
            // Validate AST edits: flag zero-match as diagnostic warning
            result.diagnostics.push({
              filePath: relPath,
              message: `AST pattern "${op.pat}" matched 0 occurrences in ${relPath}`,
              severity: 'warning',
              source: 'ast-syntactic',
            });
          }
        }
        // A zero-match astEditOps call is a no-op, not a success — the file
        // is unchanged, but this only ever surfaced as a 'warning' diagnostic,
        // which taskHadFailure doesn't check (only 'error'/'llm-patch' does).
        // Without this, a DAG task resumed with a pattern that doesn't match
        // gets marked 'completed' on the blackboard despite accomplishing
        // nothing, and the DAG moves on instead of retrying with a corrected
        // pattern.
        if (rewrites === 0) {
          taskHadFailure = true;
        }
      }

      const replacementLines = patchedContent.split('\n');
      const { unifiedDiff, origSnippet, replSnippet, startLine: windowStartLine } = generateUnifiedDiff(
        relPath,
        hashTag,
        lines,
        replacementLines
      );

      patches.push({
        filePath: relPath,
        anchorTag: hashTag,
        startLine: windowStartLine,
        endLine: lines.length,
        originalSnippet: origSnippet,
        replacementSnippet: replSnippet,
        fullPatchedContent: patchedContent, // full content for diagnostics & writes
        unifiedDiff,
        isNewFile: !fileExists,
      });

      result.astRewritesCount = (result.astRewritesCount || 0) + rewrites;
      if (run) {
        run.completedCount++;
        RunRegistry.progress(`coding_agents:${sessionId}`, relPath, run.completedCount, run.totalCount);
      }
    }

    // 4c. Atomic Multi-File Single Update with Zero-Waste Pre-Apply CAS Checkpointing
    if (!dryRun && input.resolve?.action === 'apply' && patches.length > 0) {
      // Step 1: Snapshot original files into CAS before modifying
      const preApplyMap: Record<string, string> = {};
      for (const patch of patches) {
        const fullPath = path.resolve(workspaceRoot, patch.filePath);
        if (await fs.pathExists(fullPath)) {
          preApplyMap[patch.filePath] = await fs.readFile(fullPath, 'utf-8');
        }
      }

      const checkpoint = globalCasStore.createCheckpoint(
        sessionId,
        `Pre-apply snapshot before '${input.goal}'`,
        preApplyMap
      );
      result.checkpointId = checkpoint.checkpointId;

      // Step 2: Transactional write across all files (temp files + atomic renames)
      const tempWrites: Array<{ tmpPath: string; fullPath: string }> = [];
      try {
        for (const patch of patches) {
          const fullPath = path.resolve(workspaceRoot, patch.filePath);
          if (!patch.fullPatchedContent?.trim()) {
            throw new Error(`Refusing to write empty patch for ${patch.filePath} — content was blank`);
          }
          const tmpPath = `${fullPath}.oagent.${sessionId}.tmp`;
          await fs.ensureDir(path.dirname(fullPath));
          await fs.writeFile(tmpPath, patch.fullPatchedContent, 'utf-8');
          tempWrites.push({ tmpPath, fullPath });
        }

        // Commit all renames atomically
        for (const { tmpPath, fullPath } of tempWrites) {
          await fs.rename(tmpPath, fullPath);
        }
      } catch (writeErr: any) {
        // Rollback any temporary files on error
        for (const { tmpPath } of tempWrites) {
          try { await fs.remove(tmpPath); } catch { /* ignore */ }
        }
        throw writeErr;
      }
    }

    result.anchors = anchors;
    result.patchPlan = patches;
    result.patchSummary = patches.map(p => p.unifiedDiff).join('\n');

    // ── Step 5: LSP Verify (OMP-style multi-language dispatcher) ─────────────
    result.pipelineStage = 'verify';
    const diagnosticsList: DiagnosticResult[] = [];

    if (input.verifyLspDiagnostics !== false || input.lspAction) {
      for (const patch of patches) {
        const fileDiags = await dispatchLspDiagnostics(patch, workspaceRoot);
        diagnosticsList.push(...fileDiags);

        // Extract symbols for TS/JS files
        if (/\.(ts|tsx|js|jsx)$/i.test(patch.filePath)) {
          patch.symbols = await extractTsMorphSymbols(patch.filePath, patch.fullPatchedContent);
        }
      }
    }

    result.diagnostics.push(...diagnosticsList);
    result.pipelineStage = 'completed';
    // applied = true only when patches were actually written to disk
    result.applied = !dryRun && input.resolve?.action === 'apply';

    // Post-apply verification gate: diagnostics above were computed AFTER the
    // write already landed (Step 5 runs after Step 4c) — without this, a
    // patch with real compiler errors still stays on disk, diagnostics or not.
    // Observed live: an LLM-hallucinated full-file replacement produced 22
    // real TS errors (unresolved names, syntax errors) and was still applied.
    // A CAS checkpoint already exists for this apply — use it to roll back
    // automatically rather than leave broken code on disk.
    if (result.applied && result.checkpointId) {
      // runTsMorphCheck's per-file in-memory project has no lib.d.ts or sibling
      // modules loaded (by design — see its own comment), so semantic TS
      // diagnostics (code >= 2000: "Cannot find module", "Cannot find name
      // Buffer/path", etc.) are known, accepted noise on ANY real file with
      // relative imports or Node globals — not a corruption signal. Syntax
      // errors (code < 2000: malformed grammar) ARE reliable regardless of
      // missing project context, and non-ts-morph sources (subprocess: full
      // python/go/rustc compiles) are already trustworthy in full.
      const hasErrorDiagnostics = diagnosticsList.some(d =>
        d.severity === 'error' && !(d.source === 'ast-syntactic' && typeof d.code === 'number' && d.code >= 2000)
      );
      if (hasErrorDiagnostics) {
        taskHadFailure = true;
        try {
          const { restoredCount, files } = await globalCasStore.restoreCheckpointToDisk(result.checkpointId, workspaceRoot);
          // The CAS checkpoint only captures files that existed BEFORE this run
          // (Step 4c's preApplyMap) — it has no prior version of a brand-new
          // file to restore, so restoring it is a no-op for those. Delete them
          // directly instead, or a broken new file survives while the result
          // claims a clean rollback happened.
          const deletedNewFiles: string[] = [];
          for (const patch of patches) {
            if (patch.isNewFile) {
              const fullPath = path.resolve(workspaceRoot, patch.filePath);
              await fs.remove(fullPath).catch(() => {});
              deletedNewFiles.push(patch.filePath);
            }
          }
          result.applied = false;
          result.restoredFiles = [...files, ...deletedNewFiles];
          result.patchSummary = `Automatically rolled back ${restoredCount} file(s)${deletedNewFiles.length ? ` and removed ${deletedNewFiles.length} newly-created file(s)` : ''}: the applied patch introduced ${diagnosticsList.filter(d => d.severity === 'error').length} compiler error(s), which usually means the LLM's output doesn't actually belong to the target file. Checkpoint: ${result.checkpointId}. Re-run with a more explicit goal, astEditOps, or action:"resume".`;
        } catch (rollbackErr: any) {
          result.diagnostics.push({
            filePath: patches[0]?.filePath || 'unknown',
            message: `Applied patch introduced compiler errors AND automatic rollback failed (${rollbackErr.message}) — file(s) may be left in a broken state. Checkpoint ${result.checkpointId} is still available for manual rollback via resolve:{action:"rollback"}.`,
            severity: 'error',
            source: 'llm-patch',
          });
        }
      }
    }

    // Update tasks.md state if executing a tasks DAG. Blackboard: record what
    // actually happened this resume (not just flip a checkbox) — a failed
    // attempt stays 'pending' so the next resume retries the SAME task, with
    // this attempt's outcome visible in its log rather than silently lost.
    if (loadedTasks && nextPendingTask) {
      const succeeded = !taskHadFailure && !result.error;
      nextPendingTask.status = succeeded ? 'completed' : 'pending';
      const outcomeParts = [
        `resume#${taskResumeCount}`,
        `files=[${result.relevantFiles.join(', ')}]`,
        result.modelUsed ? `model=${result.modelUsed}` : 'model=none',
        `applied=${!!result.applied}`,
        `diagnostics=${result.diagnostics.length}`,
      ];
      if (!succeeded) {
        outcomeParts.push(result.error ? `error="${result.error}"` : 'outcome=failed (see diagnostics)');
      }
      (nextPendingTask.log ??= []).push(`${new Date().toISOString()} ${outcomeParts.join(' ')}`);

      await fs.writeFile(tasksFilePath, serializeTasksMarkdown(planGoal, loadedTasks), 'utf-8');
      result.tasksPlan = loadedTasks;
      result.tasksFile = 'tasks.md';
      const remaining = loadedTasks.filter(t => t.status === 'pending');
      if (remaining.length > 0) {
        result.isPaused = true;
        result.status = 'paused';
      }
    }

  } catch (err: any) {
    result.error = err.message || String(err);
  }

  if (result.status !== 'paused') {
    result.status = (result.restoredFiles && result.restoredFiles.length > 0)
      ? 'rollback'
      : (result.applied ? 'applied' : 'dry_run');
  }

  result.content = formatCodingAgentsMarkdown(result);
  result.markdown = result.content;

  await logToolCall(sessionId, 'coding_agents', input, result, Date.now() - start, !!result.error).catch(() => {});
  return result;
}
