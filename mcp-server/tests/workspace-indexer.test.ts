import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { WorkspaceIndexer } from '../src/memory/indexer.js';
import { vectorStore } from '../src/memory/vector.js';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { memoryManager } from '../src/memory/index.js';

describe('WorkspaceIndexer Integration', () => {
    const testWs = path.join(process.cwd(), 'workspace_indexer_test_silo');

    beforeAll(() => {
        // Mock embedding generation for offline/CI environments
        vi.spyOn(vectorStore, 'generateEmbedding').mockImplementation(async (text: string) => {
            const vec = new Array(384).fill(0);
            const clean = text.toLowerCase().replace(/[^a-z0-9]/g, '');
            for (let i = 0; i < clean.length; i++) {
                vec[clean.charCodeAt(i) % 384] += 1;
            }
            const norm = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0)) || 1;
            return vec.map(v => v / norm);
        });
    });

    beforeEach(async () => {
        rmSync(testWs, { recursive: true, force: true });
        mkdirSync(testWs, { recursive: true });
        
        // Clear memory for this workspace to ensure clean test state
        const scanner = new (await import('../src/cache/workspace.js')).WorkspaceScanner(testWs);
        const wsHash = await scanner.getWorkspaceHash(testWs);
        await memoryManager.clear(wsHash);
    });

    afterAll(() => {
        rmSync(testWs, { recursive: true, force: true });
    });

    it('should index files in a workspace and store them in the vector index', async () => {
        // 1. Create some test files
        writeFileSync(path.join(testWs, 'test1.ts'), 'export const hello = "world";');
        writeFileSync(path.join(testWs, 'test2.md'), '# Documentation\nThis is a test file for the indexer.');

        const indexer = new WorkspaceIndexer(testWs);
        
        // 2. Perform indexing
        const result = await indexer.indexWorkspace(testWs, true); // Force rebuild

        console.log('Indexing Result:', JSON.stringify(result, null, 2));

        expect(result.totalFiles).toBeGreaterThanOrEqual(2);
        expect(result.indexedFiles).toBeGreaterThanOrEqual(2);
        expect(result.errors).toBe(0);

        // 3. Verify they can be searched
        const searchResults = await vectorStore.search(await indexer['workspaceScanner'].getWorkspaceHash(testWs), "documentation");
        
        expect(searchResults.length).toBeGreaterThan(0);
        console.log('Search Results:', JSON.stringify(searchResults.map(r => ({ id: r.id, score: (r as any).score })), null, 2));
        const found = searchResults.some(r => r.content.includes('test file'));
        expect(found).toBe(true);
    });

    it('should skip unchanged files during incremental indexing', async () => {
        writeFileSync(path.join(testWs, 'test1.ts'), 'export const hello = "world";');
        writeFileSync(path.join(testWs, 'test2.md'), '# Documentation');

        const indexer = new WorkspaceIndexer(testWs);
        
        // Initial indexing
        await indexer.indexWorkspace(testWs, true);

        // Run again without changes
        const result = await indexer.indexWorkspace(testWs, false);

        // Should skip all files
        expect(result.skippedFiles).toBeGreaterThanOrEqual(2);
        expect(result.indexedFiles).toBe(0);
    });

    it('should re-index modified files', async () => {
        writeFileSync(path.join(testWs, 'test1.ts'), 'export const hello = "world";');
        writeFileSync(path.join(testWs, 'test2.md'), '# Documentation');

        const indexer = new WorkspaceIndexer(testWs);
        
        // Initial indexing
        await indexer.indexWorkspace(testWs, true);

        // Modify a file
        writeFileSync(path.join(testWs, 'test1.ts'), 'export const updated = "value";');

        // Run indexing again
        const result = await indexer.indexWorkspace(testWs, false);

        // Should index 1 file and skip others
        expect(result.indexedFiles).toBe(1);
        expect(result.skippedFiles).toBeGreaterThanOrEqual(1);
    });
});
