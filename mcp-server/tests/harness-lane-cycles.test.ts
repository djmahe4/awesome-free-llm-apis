/**
 * T4 — `lane`/`maxCycles` runner extension (schema + policy gating).
 *
 * A declaration may declare an ordered `harness.lane` (each entry names an
 * executable non-top_level role = one phase) and a `harness.maxCycles` cap on
 * how many times the runner may walk that phase list. Absent `lane` = legacy
 * linear behavior (no cycle semantics at all). T5 builds `phase`/`phase#cN`
 * task-ids and phase traces on top of exactly these two fields — this task
 * only lands the schema, load-time validation, and the pure policy gates.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { loadHarnessDeclaration } from '../src/harness/declaration.js';
import { laneCycleMax, canStartLaneCycle } from '../src/harness/policy.js';

// The ctf-katana checkout is not vendored in this repo — the one test below
// that reads its shipped appsec.yaml skips (never fails) when it is absent.
const CTF_KATANA_ROOT = process.env.CTF_KATANA_ROOT
  ?? path.resolve(__dirname, '..', '..', '..', 'AVST', 'ctf-katana');
const APPSEC_DECL_PATH = path.join(CTF_KATANA_ROOT, '.free-llm-mcp', 'harness', 'appsec.yaml');

const BASE_YAML = `
harness:
  name: lane-test-harness
  schemaVersion: 1
  primaryLane: research
  budget: { maxTokens: 1000, maxToolCalls: 10, maxWallMinutes: 5, supervisorShareMax: 0.2 }
  approval: { timeoutMinutes: 10, standingRules: [] }
  __LANE_BLOCK__
roles:
  top_level: { tools: [{ tool: manage_memory, actions: [search] }] }
  scanner: { tools: [{ tool: coding_agents }] }
  fixer: { tools: [{ tool: coding_agents }] }
writes: [{ tool: manage_memory, actions: [wiki_write] }]
contentDepth: { order: [abstract], default: abstract }
handoff: { schemaVersion: 1, lowConfidenceThreshold: 0.7, maxDepth: 3 }
`;

// `extra` lines are INSET two spaces: they replace __LANE_BLOCK__ inside harness:
async function writeDecl(extra: string): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), 'lane-test-'));
  await mkdir(path.join(root, '.free-llm-mcp', 'harness'), { recursive: true });
  const yaml = BASE_YAML.replace('  __LANE_BLOCK__', extra.trimEnd());
  await writeFile(path.join(root, '.free-llm-mcp', 'harness', 'lane-test.yaml'), yaml, 'utf-8');
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe('T4 lane/maxCycles schema', () => {
  it('loads lane + maxCycles from the declaration', async () => {
    const { root, cleanup } = await writeDecl('  lane: [scanner, fixer]\n  maxCycles: 3\n');
    try {
      const decl = await loadHarnessDeclaration('lane-test', root);
      expect(decl.harness.lane).toEqual(['scanner', 'fixer']);
      expect(decl.harness.maxCycles).toBe(3);
    } finally { await cleanup(); }
  });

  it('rejects an empty lane', async () => {
    const { root, cleanup } = await writeDecl('  lane: []\n');
    try {
      await expect(loadHarnessDeclaration('lane-test', root)).rejects.toThrow(/lane/);
    } finally { await cleanup(); }
  });

  it('rejects duplicate lane phases', async () => {
    const { root, cleanup } = await writeDecl('  lane: [scanner, scanner]\n');
    try {
      await expect(loadHarnessDeclaration('lane-test', root)).rejects.toThrow(/lane/);
    } finally { await cleanup(); }
  });

  it('rejects a lane phase that is not an executable role', async () => {
    const { root, cleanup } = await writeDecl('  lane: [scanner, ghost]\n');
    try {
      await expect(loadHarnessDeclaration('lane-test', root)).rejects.toThrow(/lane/);
    } finally { await cleanup(); }
  });

  it('rejects top_level as a lane phase', async () => {
    const { root, cleanup } = await writeDecl('  lane: [top_level, scanner]\n');
    try {
      await expect(loadHarnessDeclaration('lane-test', root)).rejects.toThrow(/lane/);
    } finally { await cleanup(); }
  });

  it('rejects maxCycles < 1 and maxCycles without lane', async () => {
    const bad1 = await writeDecl('  lane: [scanner]\n  maxCycles: 0\n');
    try {
      await expect(loadHarnessDeclaration('lane-test', bad1.root)).rejects.toThrow(/maxCycles/);
    } finally { await bad1.cleanup(); }
    const bad2 = await writeDecl('  maxCycles: 3\n');
    try {
      await expect(loadHarnessDeclaration('lane-test', bad2.root)).rejects.toThrow(/maxCycles/);
    } finally { await bad2.cleanup(); }
  });

  it('rejects maxCycles above the 1000 upper bound', async () => {
    const huge = await writeDecl('  lane: [scanner, fixer]\n  maxCycles: 1000000\n');
    try {
      await expect(loadHarnessDeclaration('lane-test', huge.root)).rejects.toThrow(/maxCycles must be an integer >= 1 and <= 1000/);
    } finally { await huge.cleanup(); }

    const atBound = await writeDecl('  lane: [scanner, fixer]\n  maxCycles: 1000\n');
    try {
      const decl = await loadHarnessDeclaration('lane-test', atBound.root);
      expect(decl.harness.maxCycles).toBe(1000);
    } finally { await atBound.cleanup(); }
  });
});

describe('T4 lane cycle policy gates', () => {
  it('laneCycleMax: explicit cap, implicit 1, null without lane', async () => {
    const withCap = await writeDecl('  lane: [scanner, fixer]\n  maxCycles: 3\n');
    const implicit = await writeDecl('  lane: [scanner]\n');
    const noLane = await writeDecl('');
    try {
      expect(laneCycleMax(await loadHarnessDeclaration('lane-test', withCap.root))).toBe(3);
      expect(laneCycleMax(await loadHarnessDeclaration('lane-test', implicit.root))).toBe(1);
      expect(laneCycleMax(await loadHarnessDeclaration('lane-test', noLane.root))).toBeNull();
    } finally {
      await withCap.cleanup(); await implicit.cleanup(); await noLane.cleanup();
    }
  });

  it('canStartLaneCycle: 1-based inclusive bounds; false without lane', async () => {
    const { root, cleanup } = await writeDecl('  lane: [scanner, fixer]\n  maxCycles: 3\n');
    try {
      const decl = await loadHarnessDeclaration('lane-test', root);
      expect(canStartLaneCycle(decl, 1)).toBe(true);
      expect(canStartLaneCycle(decl, 3)).toBe(true);
      expect(canStartLaneCycle(decl, 4)).toBe(false);
      expect(canStartLaneCycle(decl, 0)).toBe(false);
      expect(canStartLaneCycle(decl, 1.5)).toBe(false);

      const noLane = await writeDecl('');
      try {
        const legacy = await loadHarnessDeclaration('lane-test', noLane.root);
        expect(canStartLaneCycle(legacy, 1)).toBe(false);
      } finally { await noLane.cleanup(); }
    } finally { await cleanup(); }
  });

  it.skipIf(!existsSync(APPSEC_DECL_PATH))('the shipped appsec.yaml declares a lane of real roles with a cycle cap', async () => {
    const decl = await loadHarnessDeclaration('appsec', CTF_KATANA_ROOT);
    expect(Array.isArray(decl.harness.lane)).toBe(true);
    expect(decl.harness.lane!.length).toBeGreaterThanOrEqual(2);
    for (const phase of decl.harness.lane!) {
      expect(decl.roles[phase]).toBeDefined();
      expect(phase).not.toBe('top_level');
    }
    expect(laneCycleMax(decl)).toBeGreaterThanOrEqual(1);
    expect(canStartLaneCycle(decl, 1)).toBe(true);
    expect(canStartLaneCycle(decl, laneCycleMax(decl)! + 1)).toBe(false);
  });

  it('the builtin research-analysis declaration stays legacy (no lane semantics)', async () => {
    const decl = await loadHarnessDeclaration('research-analysis');
    expect(decl.harness.lane).toBeUndefined();
    expect(laneCycleMax(decl)).toBeNull();
    expect(canStartLaneCycle(decl, 1)).toBe(false);
  });
});
