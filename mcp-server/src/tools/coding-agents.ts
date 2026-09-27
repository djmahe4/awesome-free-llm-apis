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
import fs from 'fs-extra';
import { VectorStore, DocumentNode } from '../memory/VectorStore.js';
import { logToolCall } from '../utils/ChatLogger.js';
import { localLlmPatch } from './local-llm-patch.js';
import { RunRegistry, RunInfo } from '../pipeline/middlewares/RunRegistry.js';
import { globalCasStore, CheckpointManifest } from '../memory/ContentAddressableCheckpoint.js';

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
  const processed = pat
    .replace(/\$\$\$[A-Z0-9_]*/g, SENTINEL)  // A: mark wildcards
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')  // B: escape specials
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
  const items: string[] = [];
  for (const line of lines) {
    const clean = line.replace(/^\s*(?:\d+[.)\-]|[-*])\s+/, '').trim();
    if (clean) items.push(clean);
  }
  const taskStrings = items.length >= 2 ? items : [goal];
  return taskStrings.map((task, idx) => ({
    id: `task-${idx + 1}`,
    task,
    status: 'pending' as const,
  }));
}

function serializeTasksMarkdown(goal: string, tasks: TaskItem[]): string {
  const firstLine = goal.split('\n')[0].replace(/^#+\s*/, '');
  const lines = [`# Tasks Plan: ${firstLine}\n`];
  for (const t of tasks) {
    const check = t.status === 'completed' ? '[x]' : (t.status === 'in_progress' ? '[~]' : '[ ]');
    lines.push(`- ${check} [${t.id}] ${t.task}`);
  }
  return lines.join('\n');
}

function parseTasksMarkdown(content: string): TaskItem[] {
  const lines = content.split('\n');
  const tasks: TaskItem[] = [];
  for (const line of lines) {
    const match = line.match(/^-\s*\[([ xX~])\]\s*(?:\[([^\]]+)\])?\s*(.+)$/);
    if (match) {
      const mark = match[1].toLowerCase();
      const status: TaskItem['status'] = mark === 'x' ? 'completed' : (mark === '~' ? 'in_progress' : 'pending');
      const id = match[2] || `task-${tasks.length + 1}`;
      const task = match[3].trim();
      tasks.push({ id, task, status });
    }
  }
  return tasks;
}

/** Recovers the original plan goal recorded in a tasks.md header, so resume calls don't overwrite it with a per-task or stale `input.goal`. */
function extractGoalFromTasksMarkdown(content: string): string | undefined {
  const match = content.match(/^#\s*Tasks Plan:\s*(.+)$/m);
  return match ? match[1].trim() : undefined;
}

function extractCodeBlock(text: string): string {
  const fenced = text.match(/```(?:[a-zA-Z0-9_+-]*)\r?\n([\s\S]*?)```/);
  return fenced ? fenced[1] : text;
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
    const prompt = [
      `You are patching a single file: ${filename}.`,
      `Apply the instruction and return the COMPLETE updated file content only, inside a single code fence.`,
      `Do not include conversational text, pleasantries, apologies, or explanations outside the code fence.`,
      tasksContext ? `## Active Task & DAG Plan\n${tasksContext}` : '',
      `## Instruction\n${instruction}`,
      `## Current Content of ${filename}\n\`\`\`\n${currentContent}\n\`\`\``
    ].filter(Boolean).join('\n\n');

    const res = await useFreeLLM({
      messages: [
        { role: 'system', content: 'You are an elite coding assistant. Return only the full updated file in a code block.' },
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
      const tasks = decomposeGoalToTasks(input.goal);
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

    // ── Handle Action: 'resume' ──────────────────────────────────────────────
    if (input.action === 'resume') {
      if (await fs.pathExists(tasksFilePath)) {
        const tasksContent = await fs.readFile(tasksFilePath, 'utf-8');
        loadedTasks = parseTasksMarkdown(tasksContent);
        planGoal = extractGoalFromTasksMarkdown(tasksContent) || input.goal;
        nextPendingTask = loadedTasks.find(t => t.status === 'pending');
        if (nextPendingTask) {
          nextPendingTask.status = 'in_progress';
          activeGoal = nextPendingTask.task;
        }
      }
    }

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

    if (input.targetFiles && input.targetFiles.length > 0) {
      result.relevantFiles = input.targetFiles.map(f => path.normalize(f).replace(/\\/g, '/'));
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

        // Try local model first if available
        if (resolvedModel) {
          try {
            const llmResult = await localLlmPatch({
              filePath: fullPath,
              instruction: augmentedInstruction,
              workspace_root: workspaceRoot,
              sessionId,
            });
            if (llmResult.success && llmResult.patch?.trim()) {
              patchedContent = llmResult.patch;
              result.modelUsed = resolvedModel;
              result.usedFallbackModel = false;
              appliedPatch = true;
            } else if (llmResult.error) {
              lastFailureReason = `Local model (${resolvedModel}) failed: ${llmResult.error}`;
            }
          } catch (llmErr: any) {
            lastFailureReason = `Local model (${resolvedModel}) failed: ${llmErr.message}`;
            console.warn(`[coding-agents] ${lastFailureReason}`);
          }
        }

        // If local model not available or failed, fallback to cloud model
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
          if (cloudPatch?.trim()) {
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

    // Update tasks.md state if executing a tasks DAG
    if (loadedTasks && nextPendingTask) {
      nextPendingTask.status = 'completed';
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
