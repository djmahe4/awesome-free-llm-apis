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
  type ReverseEvidence,
} from '../src/reverse/evidence.js';

describe('Evidence Contract & Provenance', () => {
  let tmpDir: string;

  beforeEach(() => {
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
    expect(normalized.limitations).toContain('timeout reached');
    expect(normalized.provenance.trusted).toBe(false);
    expect(normalized.provenance.source).toBe('rea-mcp');
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
});
