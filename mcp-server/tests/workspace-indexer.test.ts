import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { WorkspaceIndexer } from '../src/memory/indexer.js';
import { vectorStore } from '../src/memory/vector.js';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

describe('WorkspaceIndexer Integration', () => {
    const testWs = path.join(process.cwd(), 'temp_test_indexer_ws');

    beforeEach(() => {
        rmSync(testWs, { recursive: true, force: true });
        mkdirSync(testWs, { recursive: true });
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
        const searchResults = await vectorStore.search(await indexer['workspaceScanner'].getWorkspaceHash(testWs), "documentation test file");
        
        expect(searchResults.length).toBeGreaterThan(0);
        expect(searchResults[0].content).toContain('test file');
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
