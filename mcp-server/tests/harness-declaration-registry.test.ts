/**
 * T2 — Declaration registry: global tracking + hash provenance.
 *
 * Every declaration a run deploys with is recorded in
 * `<workspaceRoot>/.free-llm-mcp/registry.json` (withFileLock, upsert):
 *   { path, sha256, source: 'builtin'|'workspace'|'path', trackedAt }
 * run.json gains `declarationPath` + `declarationSha256` (the hash AT deploy),
 * and any later resume re-hashes the file — a changed or deleted declaration
 * emits a WARN trace `declaration_tamper` (never blocks the run: policy is
 * cached for the process, the trace is the alert).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'node:os';
import crypto from 'node:crypto';
import { waitForSettled } from './helpers/wait-for-run.js';

vi.mock('../src/tools/use-free-llm.js', () => ({
  useFreeLLM: vi.fn(async () => ({ choices: [{ message: { content: 'registry mocked finding.' } }] })),
}));

function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

const GATE_DECL_YAML = [
  'harness:',
  '  name: registry-test-h',
  '  schemaVersion: 1',
  '  primaryLane: research',
  '  budget: { maxTokens: 10000, maxToolCalls: 5, maxWallMinutes: 10, supervisorShareMax: 0.2 }',
  '  approval: { timeoutMinutes: 60, standingRules: [] }',
  'roles:',
  '  researcher:',
  '    triggers: []',
  '    tools:',
  '      - tool: use_free_llm',
  '        constraints: { agentic: true }',
  'writes: []',
  'contentDepth: { order: [abstract, html, pdf], default: abstract }',
  'handoff: { schemaVersion: 1, lowConfidenceThreshold: 0.7, maxDepth: 3 }',
  '',
].join('\n');

async function makeTmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Writes a declaration into the uniform workspace harness dir. */
async function writeWorkspaceDecl(ws: string, name: string, content = GATE_DECL_YAML): Promise<string> {
  const dir = path.join(ws, '.free-llm-mcp', 'harness');
  await fs.ensureDir(dir);
  const filePath = path.join(dir, `${name}.yaml`);
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

async function readRegistryFile(ws: string): Promise<{
  version: number;
  declarations: Record<string, { path: string; sha256: string; source: string; trackedAt: number }>;
} | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(ws, '.free-llm-mcp', 'registry.json'), 'utf-8'));
  } catch {
    return null;
  }
}

async function readTamperTraces(ws: string, runId: string): Promise<any[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(ws, '.free-llm-mcp', 'harness', runId, 'trace.jsonl'), 'utf-8');
  } catch {
    return []; // no trace file at all = no tamper event
  }
  return raw.split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.type === 'declaration_tamper');
}

describe('harness declaration registry (T2)', () => {
  let ws: string; // workspace root
  let outside: string; // a dir OUTSIDE the workspace (path-like declarations)

  beforeEach(async () => {
    ws = await makeTmpDir('omp-registry-ws-');
    outside = await makeTmpDir('omp-registry-outside-');
  });

  afterEach(async () => {
    await fs.remove(ws);
    await fs.remove(outside);
  });

  it('trackDeclaration records the workspace declaration in registry.json with a real sha256', async () => {
    const { trackDeclaration } = await import('../src/harness/registry.js');
    const declPath = await writeWorkspaceDecl(ws, 'my-h');

    const entry = await trackDeclaration('my-h', ws);

    expect(entry.path).toBe(declPath);
    expect(entry.source).toBe('workspace');
    expect(typeof entry.trackedAt).toBe('number');
    expect(entry.sha256).toBe(sha256Hex(GATE_DECL_YAML));

    const registry = await readRegistryFile(ws);
    expect(registry).not.toBeNull();
    expect(registry!.version).toBe(1);
    expect(registry!.declarations[declPath]).toEqual(entry);
  });

  it('classifies source: builtin declaration dir -> builtin, outside workspace -> path', async () => {
    const { trackDeclaration } = await import('../src/harness/registry.js');

    // 'research-analysis' resolves to mcp-server's bundled harness dir (T1 order)
    const builtin = await trackDeclaration('research-analysis', ws);
    expect(builtin.source).toBe('builtin');
    expect(builtin.path).toContain(`${path.sep}harness${path.sep}research-analysis.yaml`);

    const outsideDecl = path.join(outside, 'ad-hoc.yaml');
    await fs.writeFile(outsideDecl, 'harness: {}\n', 'utf-8');
    const adhoc = await trackDeclaration(outsideDecl, ws);
    expect(adhoc.source).toBe('path');
    expect(adhoc.path).toBe(outsideDecl);
  });

  it('re-tracking upserts one entry: sha256 follows content, trackedAt stays first-seen', async () => {
    const { trackDeclaration, getDeclarationRegistry } = await import('../src/harness/registry.js');
    const declPath = await writeWorkspaceDecl(ws, 'my-h');

    const first = await trackDeclaration('my-h', ws);
    await new Promise(r => setTimeout(r, 5)); // guarantee trackedAt would differ if overwritten
    const edited = GATE_DECL_YAML + '# edited after first track\n';
    await fs.writeFile(declPath, edited, 'utf-8');
    const second = await trackDeclaration('my-h', ws);

    expect(second.sha256).toBe(sha256Hex(edited));
    expect(second.trackedAt).toBe(first.trackedAt);
    expect(second.sha256).not.toBe(first.sha256);

    const registry = await readRegistryFile(ws);
    expect(Object.keys(registry!.declarations)).toEqual([declPath]); // still ONE entry
    const list = await getDeclarationRegistry(ws);
    expect(list).toHaveLength(1);
    expect(list[0].path).toBe(declPath);
  });

  it('deployHarness records declarationPath + declarationSha256 on run.json and tracks in registry', async () => {
    const { deployHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const declPath = await writeWorkspaceDecl(ws, 'reg-run');

    const run = await deployHarness({ runId: 't2-1', harness: 'reg-run', goal: 'find the CAP theorem', workspaceRoot: ws });
    expect(run.status).toBe('running');

    const store = new HarnessStore('t2-1', ws);
    const settled = await waitForSettled(store);
    expect(settled?.status).toBe('paused_approval'); // gated by agentic:true vs payload agentic:false

    const saved = await store.loadRun();
    expect(saved?.declarationPath).toBe(declPath);
    expect(saved?.declarationSha256).toBe(sha256Hex(GATE_DECL_YAML));

    const registry = await readRegistryFile(ws);
    expect(registry!.declarations[declPath]?.source).toBe('workspace');
  });

  it('tampering the declaration between deploy and resume emits a declaration_tamper warn trace, run still completes', async () => {
    const { deployHarness, resumeHarness } = await import('../src/harness/runner.js');
    const { HarnessStore } = await import('../src/harness/store.js');
    const declPath = await writeWorkspaceDecl(ws, 'tamper-h');
    const originalSha = sha256Hex(GATE_DECL_YAML);

    await deployHarness({ runId: 't2-2', harness: 'tamper-h', goal: 'find the CAP theorem', workspaceRoot: ws });
    const store = new HarnessStore('t2-2', ws);
    const paused = await waitForSettled(store);
    expect(paused?.status).toBe('paused_approval');
    expect(await readTamperTraces(ws, 't2-2')).toHaveLength(0); // nothing suspicious yet

    const [pending] = await store.listApprovals();
    await store.decideApproval(pending.id, true, 'user');

    // Tamper AFTER deploy recorded its hash
    await fs.writeFile(declPath, GATE_DECL_YAML + '# tampered by third party\n', 'utf-8');

    await resumeHarness('t2-2', ws);
    const completed = await waitForSettled(store);
    expect(completed?.status).toBe('complete'); // warn must NOT block the run

    const tamper = await readTamperTraces(ws, 't2-2');
    expect(tamper).toHaveLength(1);
    expect(tamper[0].role).toBe('top_level');
    expect(tamper[0].data.path).toBe(declPath);
    expect(tamper[0].data.expectedSha256).toBe(originalSha);
    expect(tamper[0].data.actualSha256).toBe(sha256Hex(GATE_DECL_YAML + '# tampered by third party\n'));
    expect(tamper[0].data.reason).toBe('mismatch');
  });

  describe('verifyDeclarationIntegrity (unit)', () => {
    function syntheticRun(overrides: Record<string, unknown> = {}) {
      return {
        runId: 't2-unit',
        harness: 'registry-test-h',
        declarationName: 'reg',
        goal: 'g',
        status: 'paused_approval',
        budget: { maxTokens: 1, used: 0, reserved: 0, toolCalls: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...overrides,
      } as any;
    }

    it('passes silently (true, no trace) when hashes match', async () => {
      const { verifyDeclarationIntegrity } = await import('../src/harness/registry.js');
      const { HarnessStore } = await import('../src/harness/store.js');
      const declPath = await writeWorkspaceDecl(ws, 'ok-h');

      const store = new HarnessStore('t2-unit', ws);
      const run = syntheticRun({ declarationPath: declPath, declarationSha256: sha256Hex(GATE_DECL_YAML) });
      await store.saveRun(run);

      await expect(verifyDeclarationIntegrity(run, store)).resolves.toBe(true);
      expect(await readTamperTraces(ws, 't2-unit')).toHaveLength(0);
    });

    it('skips runs without provenance (legacy run.json) — true, no trace', async () => {
      const { verifyDeclarationIntegrity } = await import('../src/harness/registry.js');
      const { HarnessStore } = await import('../src/harness/store.js');

      const store = new HarnessStore('t2-unit', ws);
      const run = syntheticRun(); // no declarationPath/Sha256
      await store.saveRun(run);

      await expect(verifyDeclarationIntegrity(run, store)).resolves.toBe(true);
      expect(await readTamperTraces(ws, 't2-unit')).toHaveLength(0);
    });

    it('a DELETED declaration is tamper too (reason: missing, actual null)', async () => {
      const { verifyDeclarationIntegrity } = await import('../src/harness/registry.js');
      const { HarnessStore } = await import('../src/harness/store.js');
      const declPath = await writeWorkspaceDecl(ws, 'gone-h');

      const store = new HarnessStore('t2-unit', ws);
      const run = syntheticRun({ declarationPath: declPath, declarationSha256: sha256Hex(GATE_DECL_YAML) });
      await store.saveRun(run);
      await fs.remove(declPath);

      await expect(verifyDeclarationIntegrity(run, store)).resolves.toBe(false);
      const tamper = await readTamperTraces(ws, 't2-unit');
      expect(tamper).toHaveLength(1);
      expect(tamper[0].data.reason).toBe('missing');
      expect(tamper[0].data.actualSha256).toBeNull();
    });
  });
});
