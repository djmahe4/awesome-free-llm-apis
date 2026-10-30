import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { checkFresh, evidenceFromHit, keepFreshEvidence, sortCodeFirst, filesCitedIn, anyChangedSince } from '../src/memory/evidence.js';

// G3/G4 of the grounded-coding-agents plan: retrieved context must carry where it came from and be
// re-checked against the file on disk before it reaches a prompt.

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
let root = '';
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'evidence-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const ev = (p: string, content: string) => ({ path: p, contentHash: sha(content), source: 'vector' as const, retrievedAt: Date.now(), text: `File: ${p}` });

describe('checkFresh', () => {
    it('fresh when the file still hashes to what was indexed', async () => {
        await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 1;');
        expect(await checkFresh(ev('a.ts', 'export const a = 1;'), root)).toBe('fresh');
    });
    it('stale when the file changed after indexing', async () => {
        await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 2;');
        expect(await checkFresh(ev('a.ts', 'export const a = 1;'), root)).toBe('stale');
    });
    it('missing when the file is gone', async () => {
        expect(await checkFresh(ev('gone.ts', 'x'), root)).toBe('missing');
    });
    it('refuses a path that escapes the workspace', async () => {
        expect(await checkFresh(ev('../outside.ts', 'x'), root)).toBe('missing');
    });
});

describe('evidenceFromHit', () => {
    it('keeps path, hash and index time from a vector hit', () => {
        const e = evidenceFromHit({ content: 'File: a.ts\n...', contentHash: 'h1', timestamp: 123, metadata: { path: 'a.ts', type: 'file' } });
        expect(e).toMatchObject({ path: 'a.ts', contentHash: 'h1', retrievedAt: 123, source: 'vector', text: 'File: a.ts\n...' });
    });
    it('reads the path from the hit itself, as memoryManager.search returns it', () => {
        expect(evidenceFromHit({ content: 'c', contentHash: 'h', timestamp: 1, path: ['src', 'a.ts'].join(String.fromCharCode(92)) }).path).toBe('src/a.ts');
    });
    it('a hit without a path is still usable, but unverifiable', () => {
        expect(evidenceFromHit({ content: 'note', contentHash: 'h', timestamp: 1, metadata: {} })?.path).toBeUndefined();
    });
});

describe('keepFreshEvidence', () => {
    it('drops stale and missing entries and says why', async () => {
        await fs.writeFile(path.join(root, 'ok.ts'), 'ok');
        await fs.writeFile(path.join(root, 'changed.ts'), 'new');
        const list = [ev('ok.ts', 'ok'), ev('changed.ts', 'old'), ev('gone.ts', 'x'), { ...ev('x', 'x'), path: undefined as any }];
        const { kept, dropped } = await keepFreshEvidence(list, root);
        expect(kept.map(k => k.path)).toEqual(['ok.ts', undefined]);   // no path: cannot be checked, kept as is
        expect(dropped.map(d => [d.evidence.path, d.reason])).toEqual([['changed.ts', 'stale'], ['gone.ts', 'missing']]);
    });
});

describe('sortCodeFirst', () => {
    it('code, then config, then docs and unknown, keeping relevance order inside a group', () => {
        const mk = (p?: string) => ({ ...ev('x', 'x'), path: p as any });
        const out = sortCodeFirst([mk('README.md'), mk('package.json'), mk('a.ts'), mk(undefined), mk('b.py')]);
        expect(out.map(o => o.path)).toEqual(['a.ts', 'b.py', 'package.json', 'README.md', undefined]);
    });
});

describe('cached grep results', () => {
    const results = ['[Context] --- FILE: src/a.ts ---', 'L1: export const a = 1;', '[Context] --- FILE: src/b.ts ---', 'L2: x'];
    it('lists the files a cached result cites', () => {
        expect(filesCitedIn(results)).toEqual(['src/a.ts', 'src/b.ts']);
    });
    it('notices a cited file edited after the result was cached', async () => {
        await fs.mkdir(path.join(root, 'src'));
        await fs.writeFile(path.join(root, 'src/a.ts'), 'v1');
        const cachedAt = Date.now() + 1000;
        expect(await anyChangedSince(['src/a.ts'], root, cachedAt)).toBe(false);
        expect(await anyChangedSince(['src/a.ts'], root, Date.now() - 60_000)).toBe(true);
        expect(await anyChangedSince(['src/deleted.ts'], root, cachedAt)).toBe(true);
    });
});
