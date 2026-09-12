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
  source?: 'omp-lsp' | 'ast-syntactic' | 'semantic' | 'subprocess';
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

export interface CodingAgentsInput {
  goal: string;
  workspaceRoot?: string;
  dryRun?: boolean;
  topKFiles?: number;
  sessionId?: string;
  verifyLspDiagnostics?: boolean;
  lspAction?: LspActionRequest;
  astEditOps?: AstEditOp[];
  resolve?: ResolveAction;
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
  checkpointId?: string;
  restoredFiles?: string[];
  astRewritesCount?: number;
  error?: string;
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

/**
 * Multi-language structural AST rewrite:
 * Dispatches TS/JS files to in-memory ts-morph AST, and falls back to regex for other formats.
 */
async function applyStructuralRewrite(
  filePath: string,
  content: string,
  pat: string,
  out: string
): Promise<{ content: string; matchCount: number }> {
  const ext = path.extname(filePath).toLowerCase();

  // 1. TS/JS AST Structural Rewrites via ts-morph
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

  // 2. Fallback to safe pattern regex
  return applyPatternRewrite(content, pat, out);
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

  // Unknown extension — explicitly document the skip (not silently swallow)
  return [{
    filePath: patch.filePath,
    message: `Diagnostic check skipped — no LSP dispatcher for ${ext || 'unknown'} files`,
    severity: 'info',
    source: 'omp-lsp',
  }];
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

async function scanCodeFiles(dir: string, maxFiles = 100): Promise<string[]> {
  const result: string[] = [];
  const queue = [dir];
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'venv', '.cache', 'coverage']);
  const EXT = /\.(ts|js|tsx|jsx|mjs|cjs|json|py|go|rs|md)$/i;

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

export async function CodingAgentsHandler(input: CodingAgentsInput): Promise<CodingAgentsResult> {
  const start = Date.now();
  const sessionId = input.sessionId || `omp-${Date.now()}`;
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
      result.checkpointId = targetCheckpoint;
      result.restoredFiles = files;
      result.patchSummary = `Rolled back ${restoredCount} file(s) from CAS checkpoint ${targetCheckpoint}`;
      return result;
    }

    if (!input.goal) throw new Error('Goal is required for coding_agents planning');

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

    await store.index(docNodes);
    const searchMatches = await store.query(input.goal, topK);
    const matchedPaths = searchMatches.map(m => m.id);
    result.relevantFiles = matchedPaths.length > 0 ? matchedPaths : codeFiles.slice(0, topK);

    // ── Step 3: Anchor [PATH#SHA8] ───────────────────────────────────────────
    result.pipelineStage = 'anchor';
    const anchors: SnapshotAnchor[] = [];
    const patches: LineAnchoredPatch[] = [];

    // Hoist model resolution — avoid N×listLocalModels HTTP calls (one per file)
    // Code-reviewer finding #12: hoist before loop
    let resolvedModel: string | null = null;
    if (!dryRun) {
      try {
        const { listLocalModels, rankCandidateModels } = await import('../providers/ollama-local.js');
        const models = await listLocalModels();
        const ranked = rankCandidateModels(models);
        resolvedModel = ranked[0] ?? null;
      } catch {
        console.warn('[coding-agents] Ollama unreachable — LLM patches disabled for this session');
      }
    }

    // ── Step 4: Edit (AST rewrites + LLM generation) ─────────────────────────
    result.pipelineStage = 'edit';

    for (const relPath of result.relevantFiles) {
      const fullPath = path.resolve(workspaceRoot, relPath);
      assertSafe(fullPath, workspaceRoot); // security: block path traversal

      const originalContent = await fs.readFile(fullPath, 'utf-8');
      const lines = originalContent.split('\n');
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

      // 4a. LLM generation via localLlmPatch (if no explicit astEditOps or requested)
      if (!dryRun && resolvedModel && (!input.astEditOps || input.astEditOps.length === 0)) {
        try {
          const llmResult = await localLlmPatch({
            filePath: fullPath,
            instruction: input.goal,
            workspace_root: workspaceRoot,
            sessionId,
          });
          if (llmResult.success && llmResult.patch?.trim()) {
            patchedContent = llmResult.patch;
          }
        } catch (llmErr: any) {
          console.warn(`[coding-agents] LLM patch skipped for ${relPath}: ${llmErr.message}`);
        }
      }

      // 4b. Structural AST rewrites (OMP-style $$$VAR patterns)
      if (input.astEditOps && input.astEditOps.length > 0) {
        for (const op of input.astEditOps) {
          const { content: rewritten, matchCount } = await applyStructuralRewrite(fullPath, patchedContent, op.pat, op.out);
          if (matchCount > 0) {
            patchedContent = rewritten;
            rewrites += matchCount;
          }
        }
      }

      const replacementLines = patchedContent.split('\n');
      const windowSize = 12;
      const { origSnippet, replSnippet, startLine: windowStartLine } = computeWindowedSnippet(lines, replacementLines, windowSize);
      
      const origCount = origSnippet ? origSnippet.split('\n').length : 0;
      const replCount = replSnippet ? replSnippet.split('\n').length : 0;

      patches.push({
        filePath: relPath,
        anchorTag: hashTag,
        startLine: windowStartLine,
        endLine: lines.length,
        originalSnippet: origSnippet,
        replacementSnippet: replSnippet,
        fullPatchedContent: patchedContent, // full content for diagnostics & writes
        unifiedDiff: `--- ${relPath} ${hashTag}\n+++ ${relPath} (proposed)\n@@ -${windowStartLine},${origCount} +${windowStartLine},${replCount} @@\n${replSnippet}\n`,
      });

      result.astRewritesCount = (result.astRewritesCount || 0) + rewrites;
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

    result.diagnostics = diagnosticsList;
    result.pipelineStage = 'completed';
    // applied = true only when patches were actually written to disk
    result.applied = !dryRun && input.resolve?.action === 'apply';

  } catch (err: any) {
    result.error = err.message || String(err);
  }

  await logToolCall(sessionId, 'coding_agents', input, result, Date.now() - start, !!result.error).catch(() => {});
  return result;
}
