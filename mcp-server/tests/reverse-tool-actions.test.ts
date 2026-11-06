import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { reverseTool, checkNodeCompatibility, type ReverseToolInput } from '../src/tools/reverse-tool.js';

describe('reverseTool MCP handler', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverse-tool-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handles action status and reports node compatibility', async () => {
    const res = await reverseTool({ action: 'status' });
    expect(res.success).toBe(true);
    expect(res.action).toBe('status');
    expect((res.data as any).nodeVersion).toBeDefined();
    expect(typeof (res.data as any).supportedNode).toBe('boolean');
    expect((res.data as any).engineStatus).toBeDefined();
  });

  it('rejects unsupported actions', async () => {
    const res = await reverseTool({ action: 'unknown_action' as any });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Unsupported action');
  });

  it('enforces authorization for list_capabilities when target is specified', async () => {
    const res = await reverseTool({ action: 'list_capabilities', target: 'sample.exe' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('authorization');
  });

  it('rejects invalid authorization on list_capabilities with target', async () => {
    const res = await reverseTool({
      action: 'list_capabilities',
      target: 'sample.exe',
      authorization: 'foo' as any,
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe('Target analysis requires authorization framing: "ctf" | "lab" | "consent".');
  });

  it('allows list_capabilities when target has valid authorization framing', async () => {
    const res = await reverseTool({
      action: 'list_capabilities',
      target: 'sample.exe',
      authorization: 'ctf',
    });
    expect(res.success).toBe(true);
    expect(res.action).toBe('list_capabilities');
    expect(Array.isArray((res.data as any).capabilities)).toBe(true);
  });

  it('returns built-in static capabilities for list_capabilities without target', async () => {
    const res = await reverseTool({ action: 'list_capabilities' });
    expect(res.success).toBe(true);
    expect((res.data as any).capabilities).toContain('analyze_javascript');
    expect((res.data as any).capabilities).toContain('analyze_artifact');
    expect((res.data as any).capabilities).toContain('get_evidence');
    expect((res.data as any).capabilities).toContain('scan_github');
    expect((res.data as any).capabilities).toContain('inspect_gguf');
  });

  it('handles engine initialization failure gracefully and cleans up proxy in finally', async () => {
    const origEnv = process.env.REA_AGENTS_PATH;
    try {
      process.env.REA_AGENTS_PATH = 'non_existent_engine_executable_123';
      const res = await reverseTool({ action: 'list_capabilities' });
      expect(res.success).toBe(true);
      expect((res.data as any).engineBlocked.some((b: any) => b.name === 'rea-engine')).toBe(true);
    } finally {
      process.env.REA_AGENTS_PATH = origEnv;
    }
  });

  it('rejects analyze_javascript and analyze_artifact when authorization is missing', async () => {
    const jsRes = await reverseTool({ action: 'analyze_javascript', target: 'sample.js' });
    expect(jsRes.success).toBe(false);
    expect(jsRes.error).toBe('Target analysis requires authorization framing: "ctf" | "lab" | "consent".');

    const artifactRes = await reverseTool({ action: 'analyze_artifact', target: 'sample.bin' });
    expect(artifactRes.success).toBe(false);
    expect(artifactRes.error).toBe('Target analysis requires authorization framing: "ctf" | "lab" | "consent".');
  });

  it('rejects missing or whitespace target when authorization is valid', async () => {
    const resMissing = await reverseTool({
      action: 'analyze_javascript',
      target: '',
      authorization: 'lab',
    });
    expect(resMissing.success).toBe(false);
    expect(resMissing.error).toBe('Target is required.');

    const resWhitespace = await reverseTool({
      action: 'analyze_javascript',
      target: '   ',
      authorization: 'lab',
    });
    expect(resWhitespace.success).toBe(false);
    expect(resWhitespace.error).toBe('Target is required.');
  });

  it('rejects get_evidence when authorization is missing', async () => {
    const res = await reverseTool({ action: 'get_evidence', target: 'ev-123' });
    expect(res.success).toBe(false);
    expect(res.error).toBe('Target analysis requires authorization framing: "ctf" | "lab" | "consent".');
  });

  it('handles node version with v prefix in checkNodeCompatibility', () => {
    const res = checkNodeCompatibility('v22.19.0');
    expect(res.supported).toBe(true);
    expect(res.version).toBe('v22.19.0');
  });

  it('rejects null or non-object input in reverseTool', async () => {
    const res = await reverseTool(null as any);
    expect(res.success).toBe(false);
    expect(res.action).toBe('unknown');
    expect(res.error).toBe('Input must be an object');
  });

  it('executes analyze_javascript with authorization lab on a valid JS file', async () => {
    const tempFile = path.join(tmpDir, 'service.js');
    fs.writeFileSync(tempFile, 'const a = 10; function run() { return a * 2; } module.exports = { run };', 'utf8');

    const res = await reverseTool({
      action: 'analyze_javascript',
      target: tempFile,
      authorization: 'lab',
      options: { workspaceRoot: tmpDir },
    });

    expect(res.success).toBe(true);
    expect(res.action).toBe('analyze_javascript');
    expect(res.target).toBe(tempFile);
    expect(res.evidence).toBeDefined();
    expect(res.evidence?.evidence_id).toMatch(/^ev-[a-f0-9]{16}$/);
    expect(res.data).toBeDefined();
  });

  it('executes analyze_artifact with authorization consent on a valid file', async () => {
    const packageJsonPath = path.resolve(__dirname, '../package.json');
    const res = await reverseTool({
      action: 'analyze_artifact',
      target: packageJsonPath,
      authorization: 'consent',
      options: { workspaceRoot: path.resolve(__dirname, '..') },
    });

    expect(res.success).toBe(true);
    expect(res.action).toBe('analyze_artifact');
    expect(res.target).toBe(packageJsonPath);
    expect(res.evidence).toBeDefined();
    expect(res.evidence?.evidence_id).toMatch(/^ev-[a-f0-9]{16}$/);
    expect(res.data).toBeDefined();
    expect((res.data as any).format).toBeDefined();
  });

  it('retrieves evidence via get_evidence using returned evidence_id', async () => {
    const tempFile = path.join(tmpDir, 'source.js');
    fs.writeFileSync(tempFile, 'console.log("evidence test");', 'utf8');

    const analysisRes = await reverseTool({
      action: 'analyze_javascript',
      target: tempFile,
      authorization: 'lab',
      options: { workspaceRoot: tmpDir },
    });
    expect(analysisRes.success).toBe(true);
    const evidenceId = analysisRes.evidence!.evidence_id;

    const getRes = await reverseTool({
      action: 'get_evidence',
      target: evidenceId,
      authorization: 'consent',
    });

    expect(getRes.success).toBe(true);
    expect(getRes.action).toBe('get_evidence');
    expect(getRes.target).toBe(evidenceId);
    expect(getRes.evidence).toBeDefined();
    expect(getRes.evidence?.evidence_id).toBe(evidenceId);
    expect(getRes.data).toEqual(analysisRes.evidence);
  });

  it('returns error when get_evidence targets non-existent evidence', async () => {
    const res = await reverseTool({
      action: 'get_evidence',
      target: 'ev-nonexistent-id',
      authorization: 'lab',
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Evidence not found');
  });
});
