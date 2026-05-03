import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { manageMemory } from '../src/tools/manage-memory.js';
import { memoryManager } from '../src/memory/index.js';
import { WorkspaceScanner } from '../src/cache/workspace.js';
import { mkdirSync, rmSync, existsSync } from 'node:fs';

// Mock useFreeLLM for store_workspace_skill tests
vi.mock('../src/tools/use-free-llm.js', () => ({
    useFreeLLM: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '```bash\necho "hello from llm"\n```' } }]
    })
}));

describe('Memory System Integration', () => {
    const ws = '/tmp/test_ws_vitest';
    const ws2 = '/tmp/test_ws_vitest_2';
    const workspaceScanner = new WorkspaceScanner(process.cwd());

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

    it('should store and retrieve manual context via memoryManager', async () => {
        const wsHash = await workspaceScanner.getWorkspaceHash(ws);
        // Store
        await memoryManager.storeToolOutput('manual_memory', { _ws: wsHash, key: 'architectural_decision' }, 'We decided to use Redis for queues.');

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
        const wsHash = await workspaceScanner.getWorkspaceHash(ws);
        await memoryManager.storeToolOutput('manual_memory', { _ws: wsHash, key: 'CaseTest' }, 'MixedCaseContent');

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

        const wsHash1 = await workspaceScanner.getWorkspaceHash(ws);
        const wsHash2 = await workspaceScanner.getWorkspaceHash(ws2);

        await memoryManager.storeToolOutput('manual_memory', { _ws: wsHash1, key: 'k1' }, 'WS1 Content');
        await memoryManager.storeToolOutput('manual_memory', { _ws: wsHash2, key: 'k2' }, 'WS2 Content');

        const res1 = (await manageMemory({ action: 'search', workspace_root: ws })) as { results: string[]; meta: any };
        const res2 = (await manageMemory({ action: 'search', workspace_root: ws2 })) as { results: string[]; meta: any };

        expect(res1.results).toContain('WS1 Content');
        expect(res1.results).not.toContain('WS2 Content');
        expect(res2.results).toContain('WS2 Content');
        expect(res2.results).not.toContain('WS1 Content');
    });

    it('should verify the internal key format used stringified JSON _ws', async () => {
        const wsHash = await workspaceScanner.getWorkspaceHash(ws);
        await memoryManager.storeToolOutput('manual_memory', { _ws: wsHash, key: 'format_test' }, 'content');

        const allKeys = await memoryManager.longTerm.list();

        // Find the key for our storage call
        const storeKey = allKeys.find(k => k.startsWith('tool:manual_memory:') && k.includes('format_test'));
        expect(storeKey).toBeDefined();

        // Check that it contains the stringified workspace hash with double quotes
        const expectedWsPart = '"_ws":';
        expect(storeKey).toContain(expectedWsPart);
    });

    it('should support synchronous retrieval immediately after storage', async () => {
        const root = '/tmp/test_ws_sync';
        if (!existsSync(root)) mkdirSync(root, { recursive: true });

        const wsHash = await workspaceScanner.getWorkspaceHash(root);
        await memoryManager.clear(wsHash);
        
        const key = 'sync_test';
        const content = 'This must be found immediately!';

        await memoryManager.storeToolOutput('manual_memory', { _ws: wsHash, key }, content);

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

    it('should generate scripts when using store_workspace_skill', async () => {
        const { storeWorkspaceSkill } = await import('../src/tools/store-workspace-skill.js');
        const root = '/tmp/test_ws_skill';
        if (!existsSync(root)) mkdirSync(root, { recursive: true });

        await storeWorkspaceSkill({
            name: 'test-skill',
            description: 'A test skill',
            what: ['It does things'],
            workspace_root: root,
            script_instructions: {
                'run.sh': 'Generate a script that echoes hello'
            }
        });

        // Verify the script was created
        const { promises: fs } = await import('fs');
        const path = await import('path');
        const scriptPath = path.join(root, '.free-llm-mcp', 'skills', 'test-skill', 'scripts', 'run.sh');
        
        const exists = existsSync(scriptPath);
        expect(exists).toBe(true);
        if (exists) {
            const content = await fs.readFile(scriptPath, 'utf-8');
            // Should match the mocked output in vi.mock
            expect(content).toBe('echo "hello from llm"');
        }

        // Cleanup
        rmSync(root, { recursive: true, force: true });
    });

    it('should retrieve relevant semantic search results using vector memory', async () => {
        const root = '/tmp/test_ws_vector';
        if (!existsSync(root)) mkdirSync(root, { recursive: true });
        const wsHash = Buffer.from(root).toString('base64').slice(0, 8);

        // Store some memories
        await memoryManager.storeToolOutput('auto_memory', { _ws: wsHash, id: '1' }, "We deployed the frontend to Vercel using Next.js");
        await memoryManager.storeToolOutput('auto_memory', { _ws: wsHash, id: '2' }, "The backend uses PostgreSQL for relational data storage");
        
        // Wait a bit just in case, though it's awaited
        await new Promise(r => setTimeout(r, 100));

        // Semantic search (query shouldn't match any exact words to test semantics)
        const semanticRes = await memoryManager.search(wsHash, "react hosting platform");
        
        // It should match the Vercel string
        expect(semanticRes).toBeDefined();
        const found = semanticRes.find((r: any) => JSON.stringify(r).includes('Vercel'));
        expect(found).toBeDefined();

        // Cleanup
        rmSync(root, { recursive: true, force: true });
    });
});
