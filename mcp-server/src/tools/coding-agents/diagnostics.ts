import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { type DiagnosticResult } from './types.js';

// ── Multi-language LSP Dispatcher ─────────────────────────────────────────────
// OMP uses real language servers (pyright, gopls, rust-analyzer).
// We use subprocess validators as a lightweight equivalent:
//   Python → python3 ast.parse (syntax only)
//   Go     → go vet -json (static analysis)
//   Rust   → rustc --error-format json (compiler errors)
//   TS/JS  → ts-morph getPreEmitDiagnostics (syntactic + semantic)

/** A checker that hit its time limit did not find the code clean; say so instead of returning nothing. */
function timedOut(result: { error?: Error & { code?: string } }): boolean {
  return result.error?.code === 'ETIMEDOUT';
}

function timeoutNotice(filePath: string, tool: string, seconds: number): DiagnosticResult {
  return { filePath, message: `${tool} timed out after ${seconds}s; this file was not checked`, severity: 'warning', source: 'subprocess' };
}

export function getPythonCmd(): string | null {
  for (const cmd of ['python', 'python3']) {
    try {
      const res = spawnSync(cmd, ['--version'], { encoding: 'utf-8', timeout: 3000, windowsHide: true });
      if (res.status === 0) return cmd;
    } catch { /* try next */ }
  }
  return null;
}

export function runPythonAstCheck(filePath: string, content: string): DiagnosticResult[] {
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

  if (timedOut(result)) return [timeoutNotice(filePath, 'python syntax check', 10)];
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

export function runGoVetCheck(filePath: string, workspaceRoot: string): DiagnosticResult[] {
  const dir = path.dirname(path.resolve(workspaceRoot, filePath));
  const result = spawnSync('go', ['vet', './...'], {
    cwd: dir,
    encoding: 'utf-8',
    timeout: 30_000,
  });

  const diags: DiagnosticResult[] = [];
  if (timedOut(result)) return [timeoutNotice(filePath, 'go vet', 30)];
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

export function runRustcCheck(filePath: string, content: string): DiagnosticResult[] {
  // rustc needs a real file. It goes in the OS temp dir, never next to the user's source, and the
  // module uses real ESM imports: a require() here threw inside an ES module and every Rust edit was
  // reported clean.
  const tmpFile = path.join(os.tmpdir(), `oagent-${process.pid}-${Date.now()}-${path.basename(filePath).replace(/[^\w.-]/g, '_')}.rs`);
  try {
    fs.writeFileSync(tmpFile, content, 'utf-8');
    // metadata only, written to the temp dir: no binary lands in the current directory
    const outFile = `${tmpFile}.rmeta`;
    const result = spawnSync('rustc', ['--edition', '2021', '--error-format', 'json', '--emit=metadata', '-o', outFile, tmpFile], {
      encoding: 'utf-8',
      timeout: 30_000,
    });
    fs.rmSync(tmpFile, { force: true });
    fs.rmSync(outFile, { force: true });

    const diags: DiagnosticResult[] = [];
    if (timedOut(result)) return [timeoutNotice(filePath, 'rustc', 30)];
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
    fs.rmSync(tmpFile, { force: true });
    return [];
  }
}

export async function runTsMorphCheck(
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

export async function extractTsMorphSymbols(
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
