import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {
  EpisodicProbeCache,
  globalEpisodicCache,
  makeProbeCacheKey,
  RELATIVE_PROBE_CACHE_PATH,
  type ProbeResult,
} from '../src/tools/coding-agents/episodic-probe-cache.js';

describe('EpisodicProbeCache', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'probe-cache-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('cold miss returns undefined for unvisited probe', () => {
    const cache = new EpisodicProbeCache({ workspaceRoot: tempDir });
    const result = cache.get('src/auth.ts', 'hash-1111', 'defined:login');
    expect(result).toBeUndefined();
    expect(cache.has('src/auth.ts', 'hash-1111', 'defined:login')).toBe(false);
  });

  it('warm hit on identical hash returns cached ProbeResult', () => {
    const cache = new EpisodicProbeCache({ workspaceRoot: tempDir });
    const probeRes: ProbeResult = {
      status: 'confirmed',
      evidence: 'login defined at src/auth.ts:L12',
    };

    cache.set('src/auth.ts', 'hash-1111', 'defined:login', probeRes);

    const hit = cache.get('src/auth.ts', 'hash-1111', 'defined:login');
    expect(hit).toEqual(probeRes);
    expect(cache.has('src/auth.ts', 'hash-1111', 'defined:login')).toBe(true);
  });

  it('miss on changed hash returns undefined', () => {
    const cache = new EpisodicProbeCache({ workspaceRoot: tempDir });
    const probeRes: ProbeResult = {
      status: 'confirmed',
      evidence: 'login defined at src/auth.ts:L12',
    };

    cache.set('src/auth.ts', 'hash-original', 'defined:login', probeRes);

    // Warm hit on original
    expect(cache.get('src/auth.ts', 'hash-original', 'defined:login')).toEqual(probeRes);

    // Changed hash on same file and probe yields miss
    const changedHit = cache.get('src/auth.ts', 'hash-modified', 'defined:login');
    expect(changedHit).toBeUndefined();
    expect(cache.has('src/auth.ts', 'hash-modified', 'defined:login')).toBe(false);
  });

  it('disk flush and load round-trips cached probes at .free-llm-mcp/episodic/probe-cache.json', async () => {
    const cache = new EpisodicProbeCache({ workspaceRoot: tempDir });
    const r1: ProbeResult = {
      status: 'confirmed',
      evidence: 'add takes 2 params',
    };
    const r2: ProbeResult = {
      status: 'refuted',
      evidence: 'multiply not defined',
    };

    cache.set('src/math.ts', 'sha-a1', 'arity:add@src/math.ts=2', r1);
    cache.set('src/math.ts', 'sha-a1', 'defined:multiply', r2);

    await cache.flush();

    // Verify file exists on disk at expected path
    const expectedDiskPath = path.join(tempDir, RELATIVE_PROBE_CACHE_PATH);
    const diskContent = await fs.readFile(expectedDiskPath, 'utf-8');
    const parsed = JSON.parse(diskContent);

    const key1 = makeProbeCacheKey('src/math.ts', 'sha-a1', 'arity:add@src/math.ts=2');
    const key2 = makeProbeCacheKey('src/math.ts', 'sha-a1', 'defined:multiply');
    expect(parsed[key1]).toBeDefined();
    expect(parsed[key1].result).toEqual(r1);
    expect(parsed[key2]).toBeDefined();
    expect(parsed[key2].result).toEqual(r2);

    // Create a new cache instance and load from disk
    const reloadedCache = new EpisodicProbeCache({ workspaceRoot: tempDir });
    expect(reloadedCache.get('src/math.ts', 'sha-a1', 'arity:add@src/math.ts=2')).toBeUndefined();

    await reloadedCache.load();

    expect(reloadedCache.get('src/math.ts', 'sha-a1', 'arity:add@src/math.ts=2')).toEqual(r1);
    expect(reloadedCache.get('src/math.ts', 'sha-a1', 'defined:multiply')).toEqual(r2);
    expect(reloadedCache.get('src/math.ts', 'sha-different', 'defined:multiply')).toBeUndefined();
  });

  it('enforces TTL of 7 days (expires old entries)', () => {
    const cache = new EpisodicProbeCache({ workspaceRoot: tempDir, ttlMs: 100 }); // 100ms TTL for test
    const r: ProbeResult = { status: 'confirmed', evidence: 'ok' };

    const oldTimestamp = Date.now() - 500;
    cache.set('src/old.ts', 'hash-1', 'defined:foo', r, oldTimestamp);

    expect(cache.get('src/old.ts', 'hash-1', 'defined:foo')).toBeUndefined();
  });

  it('enforces eviction cap (drops oldest entry)', () => {
    const cache = new EpisodicProbeCache({ workspaceRoot: tempDir, maxEntries: 2 });
    const r: ProbeResult = { status: 'confirmed', evidence: 'ok' };

    cache.set('f1.ts', 'h1', 'p1', r);
    cache.set('f2.ts', 'h2', 'p2', r);
    cache.set('f3.ts', 'h3', 'p3', r);

    expect(cache.size).toBe(2);
    expect(cache.get('f1.ts', 'h1', 'p1')).toBeUndefined(); // evicted
    expect(cache.get('f2.ts', 'h2', 'p2')).toEqual(r);
    expect(cache.get('f3.ts', 'h3', 'p3')).toEqual(r);
  });

  it('exports globalEpisodicCache singleton', () => {
    expect(globalEpisodicCache).toBeInstanceOf(EpisodicProbeCache);
  });
});
