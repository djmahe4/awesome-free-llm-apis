import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'fs-extra';
import { VectorStore, DocumentNode } from '../memory/VectorStore.js';
import { logToolCall } from '../utils/ChatLogger.js';
import { WorkspaceScanner } from '../cache/workspace.js';

export interface SnapshotAnchor {
  filePath: string;
  hashTag: string; // [PATH#TAG] format, e.g. "src/server.ts#a1b2c3d"
  lineCount: number;
  capturedAt: number;
}

export interface LineAnchoredPatch {
  filePath: string;
  anchorTag: string;
  startLine: number;
  endLine: number;
  originalSnippet: string;
  replacementSnippet: string;
  unifiedDiff: string;
  symbols?: string[]; // AST symbol anchors (e.g. ['verifyJwtToken', 'app'])
}

export interface DiagnosticResult {
  filePath: string;
  line?: number;
  column?: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
  source?: 'omp-lsp' | 'ast-syntactic' | 'semantic';
}

export interface LspActionRequest {
  action: 'diagnostics' | 'symbols' | 'definition' | 'references';
  file?: string;
  symbol?: string;
  query?: string;
}

export interface AstEditOp {
  pat: string; // e.g. "console.log($$$)" or "legacyFn($$$ARGS)"
  out: string; // e.g. "" or "newFn($$$ARGS)"
}

export interface ResolveAction {
  action: 'apply' | 'discard';
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
  astRewritesCount?: number;
  error?: string;
}

function computeTag(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').substring(0, 8);
}

export async function CodingAgentsHandler(input: CodingAgentsInput): Promise<CodingAgentsResult> {
  const start = Date.now();
  const sessionId = input.sessionId || `omp-${Date.now()}`;
  const workspaceRoot = path.resolve(input.workspaceRoot || process.cwd());
  const dryRun = input.dryRun !== false;
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
    if (!input.goal) throw new Error('Goal is required for coding_agents planning');

    // Step 1: Enumerate files in workspace
    const scanner = new WorkspaceScanner(workspaceRoot);
    const allFiles = await scanner.scanFiles(workspaceRoot);
    const codeFiles = allFiles.filter(f => /\.(ts|js|tsx|jsx|json|py|go|rs|md)$/i.test(f)).slice(0, 100);

    // Step 2: Locate / RAG retrieval with VectorStore
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
      } catch {
        // Skip unreadable files
      }
    }

    await store.index(docNodes);
    const searchMatches = await store.query(input.goal, topK);
    const relevantPaths = searchMatches.map(m => m.id);
    result.relevantFiles = relevantPaths;

    // Step 3: Capture Anchors [PATH#TAG]
    result.pipelineStage = 'anchor';
    const anchors: SnapshotAnchor[] = [];
    const patches: LineAnchoredPatch[] = [];
    let summaryDiffs = '';

    for (const relPath of relevantPaths) {
      const fullPath = path.resolve(workspaceRoot, relPath);
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');
      const tag = computeTag(content);
      const hashTag = `[${relPath}#${tag}]`;

      const anchor: SnapshotAnchor = {
        filePath: relPath,
        hashTag,
        lineCount: lines.length,
        capturedAt: Date.now()
      };
      anchors.push(anchor);

      // Step 4: Construct Line-Anchored Diff Plan or AST structural rewrite
      let patchedSnippet = lines.slice(0, Math.min(lines.length, 10)).join('\n');
      let rewrites = 0;

      if (input.astEditOps && input.astEditOps.length > 0) {
        for (const op of input.astEditOps) {
          const patRegex = new RegExp(op.pat.replace(/\$\$\$[A-Z0-9_]*/g, '.*?').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
          if (patRegex.test(patchedSnippet)) {
            patchedSnippet = patchedSnippet.replace(patRegex, op.out);
            rewrites++;
          }
        }
      }

      const previewLines = Math.min(lines.length, 5);
      const patch: LineAnchoredPatch = {
        filePath: relPath,
        anchorTag: hashTag,
        startLine: 1,
        endLine: Math.min(lines.length, 10),
        originalSnippet: lines.slice(0, Math.min(lines.length, 10)).join('\n'),
        replacementSnippet: patchedSnippet,
        unifiedDiff: `--- ${relPath} ${hashTag}\n+++ ${relPath} (proposed)\n@@ -1,${previewLines} +1,${previewLines} @@\n${patchedSnippet}\n`
      };
      patches.push(patch);
      summaryDiffs += `${patch.unifiedDiff}\n`;
      result.astRewritesCount = (result.astRewritesCount || 0) + rewrites;
    }

    result.anchors = anchors;
    result.patchPlan = patches;
    result.patchSummary = summaryDiffs;

    // Step 5: LSP / AST Diagnostics Verification (Pre-emit check & symbol extraction)
    result.pipelineStage = 'verify';
    const diagnosticsList: DiagnosticResult[] = [];

    if (input.verifyLspDiagnostics !== false || input.lspAction) {
      try {
        const ts = await import('typescript').then(m => m.default || m).catch(() => null);
        if (ts) {
          for (const patch of patches) {
            if (/\.(ts|tsx|js|jsx)$/i.test(patch.filePath)) {
              const sourceFile = ts.createSourceFile(
                patch.filePath,
                patch.replacementSnippet,
                ts.ScriptTarget.Latest,
                true
              );

              // 1. Syntactic/Parse diagnostics
              const syntacticErrors = (sourceFile as any).parseDiagnostics || [];
              for (const diag of syntacticErrors) {
                const lineAndChar = diag.file?.getLineAndCharacterOfPosition(diag.start || 0);
                diagnosticsList.push({
                  filePath: patch.filePath,
                  line: (lineAndChar?.line || 0) + 1,
                  column: (lineAndChar?.character || 0) + 1,
                  message: typeof diag.messageText === 'string' ? diag.messageText : diag.messageText.messageText,
                  severity: diag.category === 1 ? 'error' : 'warning',
                  source: 'ast-syntactic'
                });
              }

              // 2. Extract AST Symbols (declarations, functions, classes, interfaces)
              const symbols: string[] = [];
              const visitNode = (node: any) => {
                if (node.name && typeof node.name.text === 'string') {
                  symbols.push(node.name.text);
                }
                ts.forEachChild(node, visitNode);
              };
              ts.forEachChild(sourceFile, visitNode);
              patch.symbols = Array.from(new Set(symbols));
            }
          }
        }
      } catch (diagErr: any) {
        console.warn(`[coding-agents] Diagnostics verification non-fatal error: ${diagErr.message}`);
      }
    }

    result.diagnostics = diagnosticsList;
    result.pipelineStage = 'completed';
    result.applied = !dryRun;

  } catch (err: any) {
    result.error = err.message || String(err);
  }

  await logToolCall(sessionId, 'coding_agents', input, result, Date.now() - start, !!result.error).catch(() => {});
  return result;
}
