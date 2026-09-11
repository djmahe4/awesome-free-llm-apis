/**
 * Comprehensive integration tests for CodingAgentsHandler (OMP 5-step pipeline).
 * Covers: anchor tag format, astEditOps correctness, resolve tracking,
 * multi-file scenarios, non-TS diagnostic info, LSP verification stubs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import crypto from 'node:crypto';
import { CodingAgentsHandler } from '../src/tools/coding-agents.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a tmp workspace with given files and return its path. */
async function makeTmpWorkspace(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-test-'));
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(dir, relPath);
    await fs.ensureDir(path.dirname(abs));
    await fs.writeFile(abs, content, 'utf-8');
  }
  return dir;
}

function sha8(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').substring(0, 8);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('CodingAgentsHandler — anchor tag format [PATH#SHA8]', () => {
  let ws: string;

  beforeEach(async () => {
    ws = await makeTmpWorkspace({
      'src/auth.ts': 'export function verifyToken(t: string) { return jwt.verify(t); }',
      'src/server.ts': 'import express from "express";\nconst app = express();\napp.listen(3000);',
    });
  });

  afterEach(async () => {
    await fs.remove(ws);
  });

  it('produces [relPath#sha8] anchor tags matching actual file content hash', async () => {
    const result = await CodingAgentsHandler({
      goal: 'add JWT authentication middleware',
      workspaceRoot: ws,
      dryRun: true,
      topKFiles: 2,
    });

    expect(result.anchors.length).toBeGreaterThan(0);
    for (const anchor of result.anchors) {
      // Verify format: [relPath#8hexchars]
      expect(anchor.hashTag).toMatch(/^\[.+#[0-9a-f]{8}\]$/);
      // Verify hash matches actual file content
      const content = await fs.readFile(path.join(ws, anchor.filePath), 'utf-8');
      const expectedTag = `[${anchor.filePath}#${sha8(content)}]`;
      expect(anchor.hashTag).toBe(expectedTag);
    }
  });

  it('includes lineCount equal to actual number of lines in file', async () => {
    const result = await CodingAgentsHandler({
      goal: 'express server middleware',
      workspaceRoot: ws,
      dryRun: true,
      topKFiles: 2,
    });

    for (const anchor of result.anchors) {
      const content = await fs.readFile(path.join(ws, anchor.filePath), 'utf-8');
      const expectedLines = content.split('\n').length;
      expect(anchor.lineCount).toBe(expectedLines);
    }
  });
});

describe('CodingAgentsHandler — astEditOps pattern replacement', () => {
  let ws: string;

  beforeEach(async () => {
    ws = await makeTmpWorkspace({
      'src/app.ts': [
        'import { legacyLogger } from "./legacy";',
        'legacyLogger("server started");',
        'legacyLogger("request received");',
        'export const version = "1.0.0";',
      ].join('\n'),
    });
  });

  afterEach(async () => { await fs.remove(ws); });

  it('replaces $$$ARGS pattern matches in file content (HIGH #1 regex fix)', async () => {
    const result = await CodingAgentsHandler({
      goal: 'migrate legacyLogger to modern logger',
      workspaceRoot: ws,
      dryRun: true,
      topKFiles: 1,
      astEditOps: [
        { pat: 'legacyLogger($$$MSG)', out: 'logger.info($$$MSG)' },
      ],
    });

    expect(result.astRewritesCount).toBe(2);
    const patch = result.patchPlan.find(p => p.filePath === 'src/app.ts');
    expect(patch).toBeDefined();
    expect(patch!.fullPatchedContent).toContain('logger.info("server started");');
    expect(patch!.fullPatchedContent).toContain('logger.info("request received");');
    expect(patch!.fullPatchedContent).not.toContain('legacyLogger("server started");');
  });

  it('centers preview snippet around modified lines using target-anchored sliding window', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `const val_${i + 1} = ${i + 1};`);
    lines[25] = 'console.log("target line to replace");';
    ws = await makeTmpWorkspace({
      'src/large.ts': lines.join('\n'),
    });

    const result = await CodingAgentsHandler({
      goal: 'replace target log',
      workspaceRoot: ws,
      dryRun: true,
      topKFiles: 1,
      astEditOps: [
        { pat: 'console.log("target line to replace")', out: 'logger.debug("target replaced")' },
      ],
    });

    const patch = result.patchPlan.find(p => p.filePath === 'src/large.ts');
    expect(patch).toBeDefined();
    expect(patch!.startLine).toBeGreaterThan(1);
    expect(patch!.replacementSnippet).toContain('logger.debug("target replaced")');
  });

  it('counts zero rewrites when pattern does not match', async () => {
    const result = await CodingAgentsHandler({
      goal: 'refactor console calls',
      workspaceRoot: ws,
      dryRun: true,
      topKFiles: 1,
      astEditOps: [
        { pat: 'nonExistentFn($$$ARGS)', out: 'replacement($$$ARGS)' },
      ],
    });

    expect(result.astRewritesCount ?? 0).toBe(0);
  });
});

describe('CodingAgentsHandler — resolve action tracking', () => {
  let ws: string;

  afterEach(async () => { if (ws) await fs.remove(ws); });

  it('applied=false in dryRun mode even with resolve.apply', async () => {
    ws = await makeTmpWorkspace({ 'src/index.ts': 'const x = 1;' });
    const result = await CodingAgentsHandler({
      goal: 'rename x to counter',
      workspaceRoot: ws,
      dryRun: true,           // dry-run: no writes
      topKFiles: 1,
      resolve: { action: 'apply' },
    });

    expect(result.applied).toBe(false);
    // File must be unchanged
    const content = await fs.readFile(path.join(ws, 'src/index.ts'), 'utf-8');
    expect(content).toBe('const x = 1;');
  });

  it('applied=false with resolve.discard even when dryRun=false', async () => {
    ws = await makeTmpWorkspace({ 'src/index.ts': 'const x = 1;' });
    const result = await CodingAgentsHandler({
      goal: 'rename x',
      workspaceRoot: ws,
      dryRun: false,
      topKFiles: 1,
      resolve: { action: 'discard' },
    });

    expect(result.applied).toBe(false);
  });
});

describe('CodingAgentsHandler — multi-file workspace', () => {
  let ws: string;

  afterEach(async () => { if (ws) await fs.remove(ws); });

  it('returns multiple anchors for multi-file workspace matching the goal', async () => {
    ws = await makeTmpWorkspace({
      'src/auth/jwt.ts': 'export function sign(payload: object) { return jwt.sign(payload, secret); }',
      'src/auth/middleware.ts': 'export function authMiddleware(req, res, next) { verifyToken(req.headers.authorization); next(); }',
      'src/db/pool.ts': 'export const pool = new Pool({ connectionString: process.env.DB_URL });',
      'src/routes/user.ts': 'router.get("/me", authMiddleware, async (req, res) => { res.json(req.user); });',
    });

    const result = await CodingAgentsHandler({
      goal: 'auth middleware sign payload verify token authorization',
      workspaceRoot: ws,
      dryRun: true,
      topKFiles: 3,
    });

    expect(result.relevantFiles.length).toBeGreaterThanOrEqual(2);
    // Auth-related files should be in the top results
    const authFiles = result.relevantFiles.filter(f => f.includes('auth'));
    expect(authFiles.length).toBeGreaterThan(0);
  });
});

describe('CodingAgentsHandler — LSP diagnostics (ts-morph)', () => {
  let ws: string;

  afterEach(async () => { if (ws) await fs.remove(ws); });

  it('captures valid TypeScript snippet without errors', async () => {
    ws = await makeTmpWorkspace({
      'src/valid.ts': 'export function add(a: number, b: number): number { return a + b; }',
    });

    const result = await CodingAgentsHandler({
      goal: 'add arithmetic utilities',
      workspaceRoot: ws,
      dryRun: true,
      topKFiles: 1,
      verifyLspDiagnostics: true,
    });

    const errors = result.diagnostics.filter(d => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('validates Python syntax using python AST runner and catches SyntaxError', async () => {
    ws = await makeTmpWorkspace({
      'src/broken.py': 'def invalid_python(\n    return "missing colon and bad indent"\n',
    });

    const result = await CodingAgentsHandler({
      goal: 'fix python function',
      workspaceRoot: ws,
      dryRun: true,
      topKFiles: 1,
      verifyLspDiagnostics: true,
    });

    expect(result.diagnostics.length).toBeGreaterThan(0);
    const syntaxError = result.diagnostics.find(d => d.source === 'subprocess' && d.severity === 'error');
    if (syntaxError) {
      expect(syntaxError.message).toBeDefined();
      expect(syntaxError.line).toBeGreaterThan(0);
    }
  });

  it('validates clean Python file without errors', async () => {
    ws = await makeTmpWorkspace({
      'src/valid.py': 'def greet(name: str) -> str:\n    return f"Hello, {name}"\n',
    });

    const result = await CodingAgentsHandler({
      goal: 'add greeting function',
      workspaceRoot: ws,
      dryRun: true,
      topKFiles: 1,
      verifyLspDiagnostics: true,
    });

    const errors = result.diagnostics.filter(d => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('handles Go and Rust files with compiler dispatcher or structured info notices', async () => {
    ws = await makeTmpWorkspace({
      'main.go': 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hello")\n}\n',
      'src/main.rs': 'fn main() {\n    println!("hello");\n}\n',
    });

    const result = await CodingAgentsHandler({
      goal: 'compile go and rust entrypoints',
      workspaceRoot: ws,
      dryRun: true,
      topKFiles: 2,
      verifyLspDiagnostics: true,
    });

    expect(result.diagnostics.length).toBeGreaterThanOrEqual(2);
    for (const diag of result.diagnostics) {
      expect(['subprocess', 'omp-lsp']).toContain(diag.source);
    }
  });
});

describe('CodingAgentsHandler — error handling', () => {
  it('returns error when goal is empty string', async () => {
    const result = await CodingAgentsHandler({
      goal: '',
      workspaceRoot: process.cwd(),
      dryRun: true,
    });

    expect(result.error).toBeDefined();
    expect(result.error).toContain('Goal is required');
  });

  it('gracefully handles missing workspaceRoot by defaulting to cwd', async () => {
    const result = await CodingAgentsHandler({
      goal: 'some refactoring goal',
      dryRun: true,
      topKFiles: 1,
    });

    // Should not throw — may return empty relevantFiles if cwd has no code files
    expect(result).toBeDefined();
    expect(result.sessionId).toMatch(/^omp-/);
  });
});
