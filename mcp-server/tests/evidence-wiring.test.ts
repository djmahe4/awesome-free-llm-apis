import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

// The retrieval paths must keep provenance (semanticSearch) and must not serve a cached grep result for a file
// edited since it was cached (context gatherer).

const searchMock = vi.fn();
vi.mock('../src/memory/vector.js', async (orig) => {
    const real = await orig<typeof import('../src/memory/vector.js')>();
    return { ...real, vectorStore: { ...real.vectorStore, search: (...a: any[]) => searchMock(...a), calculateHash: real.vectorStore.calculateHash.bind(real.vectorStore) } };
});

import { memoryManager } from '../src/memory/index.js';
import { ContextGatherer, __test_clearCache } from '../src/pipeline/middlewares/context-gatherer.js';

let ws = '';
beforeEach(async () => { ws = await fs.mkdtemp(path.join(os.tmpdir(), 'evidence-wire-')); searchMock.mockReset(); __test_clearCache(); });
afterEach(async () => { await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe('memoryManager.searchWithProvenance', () => {
    it('returns the path, hash and index time of each vector hit, not only its text', async () => {
        searchMock.mockResolvedValue([{ content: 'File: src/a.ts\nRole: x', contentHash: 'h1', timestamp: 111, metadata: { path: 'src/a.ts' } }]);
        const res: any[] = (await memoryManager.searchWithProvenance('ws-prov', 'anything')) as any[];
        expect(res[0]).toMatchObject({ content: 'File: src/a.ts\nRole: x', contentHash: 'h1', path: 'src/a.ts', timestamp: 111 });
    });

    it('still deduplicates hits with the same hash', async () => {
        const hit = { content: 'c', contentHash: 'same', timestamp: 1, metadata: { path: 'a.ts' } };
        searchMock.mockResolvedValue([hit, { ...hit, content: 'c2' }]);
        expect(await memoryManager.searchWithProvenance('ws-dedupe', 'q')).toHaveLength(1);
    });
});

describe('grep context cache', () => {
    it('does not serve a cached result once a file it cites was edited', async () => {
        await fs.writeFile(path.join(ws, 'tool.ts'), 'export function frobnicate() { return "first-version"; }\n');
        const run = () => ContextGatherer.gatherContext({ workspaceRoot: ws, query: 'frobnicate', keywords: ['frobnicate'] });
        const first = (await run()).join('\n');
        expect(first).toContain('first-version');

        await new Promise(r => setTimeout(r, 30));
        await fs.writeFile(path.join(ws, 'tool.ts'), 'export function frobnicate() { return "second-version"; }\n');
        const second = (await run()).join('\n');
        expect(second).toContain('second-version');
        expect(second).not.toContain('first-version');
    }, 30000);
});
