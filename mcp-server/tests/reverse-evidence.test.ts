import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  createEvidenceBundle,
  normalizeEvidence,
  storeEvidence,
  getStoredEvidence,
  clearEvidenceMemoryCache,
  sanitizeEvidenceId,
  compareStaticAndDynamicTraces,
  type ReverseEvidence,
  type DynamicExecutionRecord,
} from '../src/reverse/evidence.js';

describe('Evidence Contract & Provenance', () => {
  let tmpDir: string;

  beforeEach(() => {
    clearEvidenceMemoryCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates structured evidence conforming to the REA specification', () => {
    const rawResult = {
      routes: ['/api/v1/users', '/api/v1/health'],
      sinks: ['eval'],
    };

    const bundle = createEvidenceBundle({
      tool: 'analyze_javascript',
      source: 'javascript_ast',
      target: '/workspace/app.js',
      normalizedResult: rawResult,
      analysisProfile: { language: 'javascript', lines: 120, sizeBytes: 3400 },
      coverage: { scope: 'file', status: 'complete' },
      limitations: ['Dynamic imports unparsed'],
      unknowns: ['unresolved_runtime_config'],
      observations: [{ routesCount: 2 }],
      derivations: [{ detectedSinks: ['eval'] }],
    });

    expect(bundle.evidence_id).toMatch(/^ev-[a-f0-9]{16}$/);
    expect(bundle.normalized_result).toEqual(rawResult);
    expect(bundle.analysis_profile.target).toBe('/workspace/app.js');
    expect(bundle.analysis_profile.language).toBe('javascript');
    expect(bundle.coverage.status).toBe('complete');
    expect(bundle.limitations).toContain('Dynamic imports unparsed');
    expect(bundle.list_unknowns).toContain('unresolved_runtime_config');
    expect(bundle.observations).toHaveLength(1);
    expect(bundle.derivations).toHaveLength(1);
    expect(bundle.provenance.trusted).toBe(false);
    expect(bundle.provenance.tool).toBe('analyze_javascript');
    expect(bundle.provenance.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('normalizes unshaped or raw engine JSON into the Evidence Contract', () => {
    const raw = {
      evidence_id: 'ev-custom-1',
      normalized_result: { files: 3 },
      limitations: ['timeout reached'],
    };

    const normalized = normalizeEvidence(raw, { tool: 'inspect_artifact', target: 'bundle.asar' });
    expect(normalized.evidence_id).toBe('ev-custom-1');
    expect(normalized.normalized_result).toEqual({ files: 3 });
    expect(normalized.analysis_profile.target).toBe('bundle.asar');
    expect(normalized.limitations).toContain('timeout reached');
    expect(normalized.provenance.trusted).toBe(false);
    expect(normalized.provenance.source).toBe('rea-mcp');
  });

  it('populates default coverage, limitations, and list_unknowns when normalizing partial object', () => {
    const partial = {
      raw_findings: ['sample'],
    };

    const normalized = normalizeEvidence(partial, { tool: 'binary_analyzer' });
    expect(normalized.coverage).toEqual({ scope: 'file', status: 'complete' });
    expect(normalized.limitations).toEqual([]);
    expect(normalized.list_unknowns).toEqual([]);
    expect(normalized.residualUnknowns).toEqual([]);
    expect(normalized.observations).toEqual([]);
    expect(normalized.provenance.trusted).toBe(false);
  });

  it('persists and retrieves evidence bundles by ID from disk after cache clear', () => {
    const bundle = createEvidenceBundle({
      tool: 'inspect_artifact',
      source: 'binary_analyzer',
      target: 'sample.wasm',
      normalizedResult: { magic: 'WASM' },
    });

    storeEvidence(bundle, tmpDir);

    // Strictly clear memory cache to ensure retrieval reads from persisted disk file
    clearEvidenceMemoryCache();

    const retrieved = getStoredEvidence(bundle.evidence_id, tmpDir);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.evidence_id).toBe(bundle.evidence_id);
    expect(retrieved?.normalized_result).toEqual({ magic: 'WASM' });
  });

  it('sanitizes evidence ID preventing path traversal', () => {
    expect(sanitizeEvidenceId('ev-../../secret')).toBe('ev-secret');
    expect(sanitizeEvidenceId('ev-123/456\\test')).toBe('ev-123456test');
    expect(sanitizeEvidenceId('')).toBe('ev-unknown');
    expect(sanitizeEvidenceId('a'.repeat(100)).length).toBe(64);
  });

  it('handles circular references in raw data safely without throwing', () => {
    const circular: Record<string, unknown> = { key: 'value' };
    circular.self = circular;

    expect(() => {
      const bundle = createEvidenceBundle({
        tool: 'inspect_artifact',
        source: 'runtime_memory',
        raw: circular,
      });
      expect(bundle.evidence_id).toMatch(/^ev-/);
      expect(bundle.provenance.sha256).toBeDefined();
    }).not.toThrow();
  });

  it('enforces trusted=false and caches in memory when normalizing fully formed evidence', () => {
    const fullyFormed = {
      evidence_id: 'ev-existing-1',
      normalized_result: { ok: true },
      provenance: { source: 'external', sha256: 'abc', tool: 'ext', trusted: true as any },
    };

    clearEvidenceMemoryCache();
    const normalized = normalizeEvidence(fullyFormed, { tool: 'inspect_artifact' });
    expect(normalized.provenance.trusted).toBe(false);

    // Verify it was added to memory store
    const cached = getStoredEvidence('ev-existing-1');
    expect(cached).not.toBeNull();
    expect(cached?.evidence_id).toBe('ev-existing-1');
  });

  it('returns null when querying non-existent evidence ID', () => {
    const nonExistent = getStoredEvidence('ev-nonexistent', tmpDir);
    expect(nonExistent).toBeNull();
  });

  it('refreshes LRU recency on get and evicts oldest unaccessed entry', () => {
    for (let i = 0; i < 500; i++) {
      normalizeEvidence({ evidence_id: `ev-lru-${i}` }, { tool: 'test' });
    }

    const refreshed = getStoredEvidence('ev-lru-0');
    expect(refreshed).not.toBeNull();

    normalizeEvidence({ evidence_id: 'ev-lru-500' }, { tool: 'test' });

    expect(getStoredEvidence('ev-lru-0')).not.toBeNull();
    expect(getStoredEvidence('ev-lru-1')).toBeNull();
    expect(getStoredEvidence('ev-lru-500')).not.toBeNull();
  });

  it('sanitizes evidence_id, spreads coverage, and falls back to unknowns in normalizeEvidence', () => {
    const normalized = normalizeEvidence({
      evidence_id: 'ev-../../bad/id#1',
      coverage: { status: 'partial' as const },
      unknowns: ['unresolved_symbol'],
    }, { tool: 'test' });

    expect(normalized.evidence_id).toBe('ev-badid1');
    expect(normalized.coverage).toEqual({ scope: 'file', status: 'partial' });
    expect(normalized.list_unknowns).toEqual(['unresolved_symbol']);
    expect(normalized.residualUnknowns).toEqual(['unresolved_symbol']);
  });
it('detects discrepancies between static AST predictions and dynamic execution traces', () => {
    const staticFindings = {
      functions: ['authHandler', 'decoyServiceMirage', 'realPaymentProcess'],
      endpoints: ['/api/v1/login', '/api/v1/pay'],
    };

    const dynamicRuns: DynamicExecutionRecord[] = [
      {
        runId: 'run-1',
        timestamp: new Date().toISOString(),
        executedFunctions: ['authHandler', 'realPaymentProcess'],
        networkEndpointsInvoked: ['/api/v1/login', '/hidden/dynamic/telemetry'],
        stackTraces: ['Error\n    at authHandler (auth.js:12:5)'],
      },
    ];

    const discrepancies = compareStaticAndDynamicTraces(staticFindings, dynamicRuns);
    expect(discrepancies.length).toBe(2);

    const decoy = discrepancies.find(d => d.category === 'unexecuted_static_decoy');
    expect(decoy).toBeDefined();
    expect(decoy?.description).toContain('decoyServiceMirage');

    const hidden = discrepancies.find(d => d.category === 'hidden_runtime_call');
    expect(hidden).toBeDefined();
    expect(hidden?.description).toContain('/hidden/dynamic/telemetry');
  });
});
