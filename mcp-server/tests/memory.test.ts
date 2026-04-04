import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { storeMemory } from '../src/tools/store-memory.js';
import { manageMemory } from '../src/tools/manage-memory.js';
import { memoryManager } from '../src/memory/index.js';
import { mkdirSync, rmSync, existsSync } from 'node:fs';

describe('Memory System Integration', () => {
    const ws = '/tmp/test_ws_vitest';
    const ws2 = '/tmp/test_ws_vitest_2';

    beforeAll(() => {
        if (!existsSync(ws)) mkdirSync(ws, { recursive: true });
        if (!existsSync(ws2)) mkdirSync(ws2, { recursive: true });
    });

    afterAll(() => {
        rmSync(ws, { recursive: true, force: true });
        rmSync(ws2, { recursive: true, force: true });
    });

    beforeEach(async () => {
        // Clear before each test
        await manageMemory({ action: 'clear', workspace_root: ws });
    });

    it('should store and retrieve manual context via store_memory', async () => {
        // Store
        const storeRes = await storeMemory({
            key: 'architectural_decision',
            content: 'We decided to use Redis for queues.',
            workspace_root: ws
        });
        expect(storeRes.success).toBe(true);

        // Search
        const searchRes = (await manageMemory({
            action: 'search',
            workspace_root: ws,
            query: 'Redis'
        })) as { results: string[]; meta: any };

        expect(searchRes.results).toHaveLength(1);
        expect(searchRes.results[0]).toBe('We decided to use Redis for queues.');
    });

    it('should correctly handle search query case-insensitivity', async () => {
        await storeMemory({
            key: 'CaseTest',
            content: 'MixedCaseContent',
            workspace_root: ws
        });

        const res = (await manageMemory({
            action: 'search',
            workspace_root: ws,
            query: 'mixedcase'
        })) as { results: string[]; meta: any };

        expect(res.results).toHaveLength(1);
        expect(res.results[0]).toBe('MixedCaseContent');
    });

    it('should retrieve different results for different workspaces', async () => {
        const ws2 = '/tmp/test_ws_vitest_2';
        await manageMemory({ action: 'clear', workspace_root: ws2 });

        await storeMemory({ key: 'k1', content: 'WS1 Content', workspace_root: ws });
        await storeMemory({ key: 'k2', content: 'WS2 Content', workspace_root: ws2 });

        const res1 = (await manageMemory({ action: 'search', workspace_root: ws })) as { results: string[]; meta: any };
        const res2 = (await manageMemory({ action: 'search', workspace_root: ws2 })) as { results: string[]; meta: any };

        expect(res1.results).toContain('WS1 Content');
        expect(res1.results).not.toContain('WS2 Content');
        expect(res2.results).toContain('WS2 Content');
        expect(res2.results).not.toContain('WS1 Content');
    });

    it('should verify the internal key format used stringified JSON _ws', async () => {
        await storeMemory({
            key: 'format_test',
            content: 'content',
            workspace_root: ws
        });

        const allKeys = await memoryManager.longTerm.list();

        // Find the key for our store_memory call
        const storeKey = allKeys.find(k => k.startsWith('tool:store_memory:') && k.includes('format_test'));
        expect(storeKey).toBeDefined();

        // Check that it contains the stringified workspace hash with double quotes
        const expectedWsPart = '"_ws":';
        expect(storeKey).toContain(expectedWsPart);
    });

    it('should support synchronous retrieval immediately after storage', async () => {
        const root = '/tmp/test_ws_sync';
        if (!existsSync(root)) mkdirSync(root, { recursive: true });

        const key = 'sync_test';
        const content = 'This must be found immediately!';

        await storeMemory({
            key,
            content,
            workspace_root: root
        });

        // Search immediately (no wait/debounce)
        const res = (await manageMemory({
            action: 'search',
            workspace_root: root,
            query: 'immediately'
        })) as { results: string[] };

        expect(res.results).toHaveLength(1);
        expect(res.results[0]).toBe(content);

        // Cleanup
        rmSync(root, { recursive: true, force: true });
    });
});
