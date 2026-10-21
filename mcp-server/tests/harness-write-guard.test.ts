import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { CodingAgentsHandler } from '../src/tools/coding-agents.js';
import { isProtectedWritePath, assertPatchPathAllowed } from '../src/harness/write-guard.js';

async function makeTmpWorkspace(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 't7-guard-'));
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(dir, relPath);
    await fs.ensureDir(path.dirname(abs));
    await fs.writeFile(abs, content, 'utf-8');
  }
  return dir;
}

const WS = '/tmp/t7-fake-workspace';

describe('isProtectedWritePath', () => {
  it('protects the uniform declaration directory', () => {
    expect(isProtectedWritePath(WS, '.free-llm-mcp/harness/appsec.yaml')).toBe(true);
    expect(isProtectedWritePath(WS, '.free-llm-mcp/harness/nested/rules.conf')).toBe(true);
    expect(isProtectedWritePath(WS, path.join(WS, '.free-llm-mcp/harness/appsec.yaml'))).toBe(true);
  });

  it('protects legacy harness yaml/yml only, case-insensitive', () => {
    expect(isProtectedWritePath(WS, 'harness/appsec.yaml')).toBe(true);
    expect(isProtectedWritePath(WS, 'harness/nested/rules.YML')).toBe(true);
    expect(isProtectedWritePath(WS, 'harness/notes.md')).toBe(false);
    expect(isProtectedWritePath(WS, 'src/harness/policy.ts')).toBe(false);
  });

  it('protects the bridges.json capability token but not sibling files', () => {
    expect(isProtectedWritePath(WS, '.free-llm-mcp/bridges.json')).toBe(true);
    expect(isProtectedWritePath(WS, '.free-llm-mcp/skills/README.md')).toBe(false);
    expect(isProtectedWritePath(WS, 'src/tools/project-bridge.ts')).toBe(false);
  });

  it('allows ordinary workspace files and ignores paths outside the workspace', () => {
    expect(isProtectedWritePath(WS, 'src/index.ts')).toBe(false);
    expect(isProtectedWritePath(WS, 'tasks.md')).toBe(false);
    expect(isProtectedWritePath(WS, '../elsewhere/harness/appsec.yaml')).toBe(false);
  });

  it('normalizes backslash separators', () => {
    expect(isProtectedWritePath(WS, 'harness\\appsec.yaml')).toBe(true);
    expect(isProtectedWritePath(WS, '.free-llm-mcp\\harness\\appsec.yaml')).toBe(true);
  });
});

describe('assertPatchPathAllowed', () => {
  it('throws a hard-deny error for protected paths', () => {
    expect(() => assertPatchPathAllowed(WS, '.free-llm-mcp/harness/appsec.yaml')).toThrow(/hard-deny/);
    expect(() => assertPatchPathAllowed(WS, 'harness/appsec.yml')).toThrow(/hard-deny/);
    expect(() => assertPatchPathAllowed(WS, '.free-llm-mcp/bridges.json')).toThrow(/hard-deny/);
  });

  it('passes allowed paths without throwing', () => {
    expect(() => assertPatchPathAllowed(WS, 'src/index.ts')).not.toThrow();
    expect(() => assertPatchPathAllowed(WS, 'harness/notes.md')).not.toThrow();
  });
});

describe('coding_agents apply — T7 hard-deny write guard', () => {
  let ws: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (ws) {
      await fs.remove(ws);
      ws = undefined;
    }
  });

  async function applyAstEdit(
    workspaceRoot: string,
    targetFile: string,
    op: { pat: string; out: string }
  ) {
    const ollamaModule = await import('../src/providers/ollama-local.js');
    vi.spyOn(ollamaModule, 'listLocalModels').mockResolvedValue([]);
    return CodingAgentsHandler({
      goal: `T7 write guard check for ${targetFile}`,
      workspaceRoot,
      targetFiles: [targetFile],
      dryRun: false,
      astEditOps: [op],
      resolve: { action: 'apply' },
    });
  }

  it('refuses an apply targeting .free-llm-mcp/harness/appsec.yaml', async () => {
    ws = await makeTmpWorkspace({ '.free-llm-mcp/harness/appsec.yaml': 'name: appsec\n' });
    const result = await applyAstEdit(ws, '.free-llm-mcp/harness/appsec.yaml', {
      pat: 'name: appsec',
      out: 'name: hijacked',
    });

    expect(result.error).toMatch(/hard-deny/);
    expect(result.applied).toBe(false);
    const content = await fs.readFile(path.join(ws, '.free-llm-mcp/harness/appsec.yaml'), 'utf-8');
    expect(content).toBe('name: appsec\n');
  });

  it('refuses an apply targeting legacy harness/appsec.yaml', async () => {
    ws = await makeTmpWorkspace({ 'harness/appsec.yaml': 'name: legacy\n' });
    const result = await applyAstEdit(ws, 'harness/appsec.yaml', {
      pat: 'name: legacy',
      out: 'name: hijacked',
    });

    expect(result.error).toMatch(/hard-deny/);
    expect(result.applied).toBe(false);
    const content = await fs.readFile(path.join(ws, 'harness/appsec.yaml'), 'utf-8');
    expect(content).toBe('name: legacy\n');
  });

  it('refuses an apply targeting .free-llm-mcp/bridges.json', async () => {
    ws = await makeTmpWorkspace({ '.free-llm-mcp/bridges.json': '{"bridges":{}}\n' });
    const result = await applyAstEdit(ws, '.free-llm-mcp/bridges.json', {
      pat: '"bridges"',
      out: '"pwned"',
    });

    expect(result.error).toMatch(/hard-deny/);
    expect(result.applied).toBe(false);
    const content = await fs.readFile(path.join(ws, '.free-llm-mcp/bridges.json'), 'utf-8');
    expect(content).toBe('{"bridges":{}}\n');
  });

  it('still applies astEditOps to an ordinary source file', async () => {
    ws = await makeTmpWorkspace({ 'src/config.ts': 'export const PORT = 3000;\n' });
    const result = await applyAstEdit(ws, 'src/config.ts', {
      pat: 'PORT = 3000',
      out: 'PORT = 8080',
    });

    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(true);
    const content = await fs.readFile(path.join(ws, 'src/config.ts'), 'utf-8');
    expect(content).toContain('PORT = 8080');
  });
});
