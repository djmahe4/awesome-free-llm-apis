import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { type DiagnosticResult, type LineAnchoredPatch } from './types.js';
import {
  getPythonCmd,
  runPythonAstCheck,
  runGoVetCheck,
  runRustcCheck,
  runTsMorphCheck,
  extractTsMorphSymbols,
} from './diagnostics.js';

// ── OMP-style LSP Action Dispatcher ──────────────────────────────────────────

export async function dispatchLspDiagnostics(
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

export function hasCommand(cmd: string): boolean {
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

