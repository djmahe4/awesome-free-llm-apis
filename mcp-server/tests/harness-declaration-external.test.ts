import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { loadHarnessDeclaration } from '../src/harness/declaration.js';
import { createMCPServer } from '../src/mcp/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Characterization tests for the external-declaration work (A1) and the MCP
// documentation surfacing it (A2). These pin the CURRENT behavior of
// resolveDeclarationPath/loadHarnessDeclaration: path-like references,
// workspace-owned discovery order, path-traversal stripping, relative
// allowedWorkspaceRoots normalization, and the process-lifetime cache.

const MINIMAL_DECL = (name: string): string => [
  `harness:`,
  `  name: ${name}`,
  `roles:`,
  `  researcher:`,
  `    triggers: []`,
  `    tools: [{ tool: use_free_llm }]`,
  ``,
].join('\n');

describe('A1 — resolveDeclarationPath: path-like references', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'decl-ext-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('loads an absolute .yaml path directly', async () => {
    const file = path.join(tmpDir, 'abs-decl.yaml');
    await fs.writeFile(file, MINIMAL_DECL('abs-h'));
    const decl = await loadHarnessDeclaration(file);
    expect(decl.harness.name).toBe('abs-h');
  });

  it('loads an absolute .yml path directly', async () => {
    const file = path.join(tmpDir, 'abs-decl.yml');
    await fs.writeFile(file, MINIMAL_DECL('abs-yml-h'));
    const decl = await loadHarnessDeclaration(file);
    expect(decl.harness.name).toBe('abs-yml-h');
  });

  it('resolves a relative path-like reference against workspaceRoot', async () => {
    await fs.ensureDir(path.join(tmpDir, 'rel'));
    await fs.writeFile(path.join(tmpDir, 'rel', 'custom.yaml'), MINIMAL_DECL('rel-h'));
    const decl = await loadHarnessDeclaration('rel/custom.yaml', tmpDir);
    expect(decl.harness.name).toBe('rel-h');
  });

  it('throws "file not found" for a missing absolute path-like reference', async () => {
    const missing = path.join(tmpDir, 'nope.yaml');
    await expect(loadHarnessDeclaration(missing)).rejects.toThrow(
      `Harness declaration file not found: ${missing}`,
    );
  });

  it('throws "file not found" for a relative path missing under workspaceRoot', async () => {
    await expect(loadHarnessDeclaration('missing/dir/x.yaml', tmpDir)).rejects.toThrow(
      /Harness declaration file not found/,
    );
  });
});

describe('A1 — resolveDeclarationPath: bare-name workspace discovery', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'decl-ext-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('falls back to <workspaceRoot>/harness/<name>.yaml when the uniform dir has none', async () => {
    await fs.ensureDir(path.join(tmpDir, 'harness'));
    await fs.writeFile(path.join(tmpDir, 'harness', 'research-analysis.yaml'), MINIMAL_DECL('ws-shadows-builtin'));
    const decl = await loadHarnessDeclaration('research-analysis', tmpDir);
    expect(decl.harness.name).toBe('ws-shadows-builtin');
  });

  it('prefers the uniform <workspaceRoot>/.free-llm-mcp/harness/<name>.yaml over the legacy harness dir', async () => {
    const uniformDir = path.join(tmpDir, '.free-llm-mcp', 'harness');
    await fs.ensureDir(uniformDir);
    await fs.writeFile(path.join(uniformDir, 'appsec-uniform.yaml'), MINIMAL_DECL('uniform-wins'));
    await fs.ensureDir(path.join(tmpDir, 'harness'));
    await fs.writeFile(path.join(tmpDir, 'harness', 'appsec-uniform.yaml'), MINIMAL_DECL('legacy-loses'));

    const decl = await loadHarnessDeclaration('appsec-uniform', tmpDir);
    expect(decl.harness.name).toBe('uniform-wins');
  });

  it('prefers the uniform .free-llm-mcp/harness dir over the built-in declaration', async () => {
    const uniformDir = path.join(tmpDir, '.free-llm-mcp', 'harness');
    await fs.ensureDir(uniformDir);
    await fs.writeFile(path.join(uniformDir, 'research-analysis.yaml'), MINIMAL_DECL('uniform-shadows-builtin'));

    const decl = await loadHarnessDeclaration('research-analysis', tmpDir);
    expect(decl.harness.name).toBe('uniform-shadows-builtin');
  });

  it('falls back to the built-in declaration when the workspace has none', async () => {
    const emptyWs = await fs.mkdtemp(path.join(os.tmpdir(), 'decl-ext-empty-'));
    try {
      const decl = await loadHarnessDeclaration('research-analysis', emptyWs);
      expect(decl.harness.name).toBe('research-analysis-harness');
    } finally {
      await fs.remove(emptyWs);
    }
  });

  it('throws listing every searched location when a bare name matches nowhere', async () => {
    const err = await loadHarnessDeclaration('no-such-harness', tmpDir).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("Harness declaration 'no-such-harness' not found");
    expect(message).toContain('looked in:');
    // all three candidates, uniform dir first
    expect(message).toContain(path.join(tmpDir, '.free-llm-mcp', 'harness', 'no-such-harness.yaml'));
    expect(message).toContain(path.join(tmpDir, 'harness', 'no-such-harness.yaml'));
    expect(message.indexOf(path.join(tmpDir, '.free-llm-mcp', 'harness', 'no-such-harness.yaml')))
      .toBeLessThan(message.indexOf(path.join(tmpDir, 'harness', 'no-such-harness.yaml')));
  });

  it('strips traversal from bare names instead of escaping the harness dirs', async () => {
    // '..' has no separator and no .yaml suffix, so it reaches the bare-name
    // branch; basename('..') = '..' and the candidate becomes '...yaml',
    // never '<workspaceRoot>/...yaml'.
    const err = await loadHarnessDeclaration('..', tmpDir).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(path.join(tmpDir, 'harness', '...yaml'));
  });

  it('treats a separator-containing reference as a path, not a harness name', async () => {
    // '../outside.yaml' is path-like (contains '/'): it resolves against
    // workspaceRoot as an operator-supplied relative path — it does NOT go
    // through basename() and does NOT silently load a sibling of <ws>/harness.
    const outside = path.join(tmpDir, 'outside.yaml');
    await fs.writeFile(outside, MINIMAL_DECL('outside-h'));
    const decl = await loadHarnessDeclaration('../outside.yaml', path.join(tmpDir, 'inner')).catch(() => null);
    // inner/ doesn't exist -> resolve(tmpDir/inner, ../outside.yaml) = tmpDir/outside.yaml
    expect(decl?.harness.name).toBe('outside-h');
  });
});

describe('A1 — loadHarnessDeclaration: normalization, cache, validation', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'decl-ext-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('normalizes relative allowedWorkspaceRoots against the declaration file directory', async () => {
    const extDir = path.join(tmpDir, 'ext');
    await fs.ensureDir(extDir);
    await fs.writeFile(path.join(extDir, 'appsec.yaml'), [
      'harness:',
      '  name: ext-h',
      '  allowedWorkspaceRoots:',
      "    - '.'",
      '    - /abs/elsewhere',
      'roles:',
      '  researcher: { triggers: [], tools: [{ tool: use_free_llm }] }',
      '',
    ].join('\n'));

    const decl = await loadHarnessDeclaration(path.join(extDir, 'appsec.yaml'));
    expect(decl.harness.allowedWorkspaceRoots).toEqual([
      extDir, // '.' resolves to the file's own directory
      '/abs/elsewhere', // absolute entries pass through untouched
    ]);
  });

  it('caches by resolved file path + workspaceRoot (same key -> same object)', async () => {
    const file = path.join(tmpDir, 'cached.yaml');
    await fs.writeFile(file, MINIMAL_DECL('cached-h'));

    const first = await loadHarnessDeclaration(file, tmpDir);
    const second = await loadHarnessDeclaration(file, tmpDir);
    expect(second).toBe(first);
  });

  it('keeps distinct cache entries per workspaceRoot for the same file', async () => {
    const otherWs = await fs.mkdtemp(path.join(os.tmpdir(), 'decl-ext-other-'));
    const file = path.join(tmpDir, 'cached.yaml');
    await fs.writeFile(file, MINIMAL_DECL('cached-h'));
    try {
      const a = await loadHarnessDeclaration(file, tmpDir);
      const b = await loadHarnessDeclaration(file, otherWs);
      expect(b).not.toBe(a);
    } finally {
      await fs.remove(otherWs);
    }
  });

  it('rejects a declaration missing harness.name or roles', async () => {
    const noName = path.join(tmpDir, 'no-name.yaml');
    await fs.writeFile(noName, 'roles:\n  researcher: { triggers: [], tools: [] }\n');
    await expect(loadHarnessDeclaration(noName)).rejects.toThrow(/Malformed harness declaration/);

    const noRoles = path.join(tmpDir, 'no-roles.yaml');
    await fs.writeFile(noRoles, 'harness:\n  name: x\n');
    await expect(loadHarnessDeclaration(noRoles)).rejects.toThrow(/Malformed harness declaration/);
  });
});

describe('A2 — MCP agent_harness docs advertise workspace discovery', () => {
  it('tool description tells callers bare names resolve from the uniform .free-llm-mcp dir first', async () => {
    const server = await createMCPServer();
    const handlers = (server as any)._requestHandlers;
    const listHandler = handlers?.get(ListToolsRequestSchema.shape.method.value);
    expect(listHandler).toBeDefined();
    const response = await listHandler({ method: 'tools/list' });
    const tool = response.tools.find((t: any) => t.name === 'agent_harness');
    expect(tool).toBeDefined();
    expect(tool.description).toContain('<workspace_root>/.free-llm-mcp/harness/<name>.yaml first');
    expect(tool.description).toContain('then the legacy <workspace_root>/harness/<name>.yaml, then the built-in dir');
  });

  it('harness input property documents the same resolution order and .yaml paths', async () => {
    const server = await createMCPServer();
    const handlers = (server as any)._requestHandlers;
    const listHandler = handlers?.get(ListToolsRequestSchema.shape.method.value);
    const response = await listHandler({ method: 'tools/list' });
    const tool = response.tools.find((t: any) => t.name === 'agent_harness');
    const harnessProp = tool.inputSchema?.properties?.harness;
    expect(harnessProp?.description).toContain('<workspace_root>/.free-llm-mcp/harness/<name>.yaml first');
    expect(harnessProp?.description).toContain('then <workspace_root>/harness/<name>.yaml');
    expect(harnessProp?.description).toContain('.yaml path is also accepted');
  });
});
