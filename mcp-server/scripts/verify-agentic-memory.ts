
import { memoryManager } from '../src/memory/index.js';
import { AgenticMiddleware } from '../src/middleware/agentic/agentic-middleware.js';
import { WorkspaceScanner } from '../src/cache/workspace.js';
import path from 'node:path';
import process from 'node:process';

async function main() {
    console.error('--- Agentic Memory Verification ---');

    const workspaceRoot = process.cwd();
    const scanner = new WorkspaceScanner(workspaceRoot);
    const wsHash = scanner.getWorkspaceHash(workspaceRoot);
    console.error(`Workspace Hash: ${wsHash}`);

    const testContent = { 
        status: 'verified', 
        message: 'Agentic Memory is functioning correctly',
        timestamp: new Date().toISOString(),
        _ws: wsHash 
    };

    console.error('1. Seeding memory (via memoryManager.longTerm.save)...');
    // Using a key format that MemoryManager.search expects: _ws:HASH
    const storageKey = `test:${Date.now()}:_ws:${wsHash}`; 
    await memoryManager.longTerm.save(storageKey, testContent);
    // Also store a secondary one with JSON format in key just in case
    await memoryManager.longTerm.save(`test2:{"ws":"${wsHash}"}`, { note: 'functioning correctly' });
    
    console.error('Flushing memory to disk...');
    await memoryManager.flush();

    console.error('2. Querying memory via Search...');
    // Use a SIMPLER query that is a guaranteed substring
    const searchQuery = 'functioning';
    const searchResults = await memoryManager.search(wsHash, searchQuery);
    console.error('Search Results Count:', searchResults.length);
    
    if (searchResults.length === 0) {
        console.error('Search debug: checking all keys to diagnose pattern mismatch...');
        const allKeys = await memoryManager.longTerm.list();
        console.error('All Keys in Store:', JSON.stringify(allKeys.slice(0, 5), null, 2));
        throw new Error('Memory search failed to return results. Workspace pattern mismatch?');
    }

    console.error('Search Results:', JSON.stringify(searchResults, null, 2));

    console.error('3. Testing AgenticMiddleware Prompt Injection...');
    const middleware = new AgenticMiddleware();
    // We must ensure the query passed to the middleware matches the seeded content
    const mockContext: any = {
        request: {
            messages: [{ role: 'user', content: 'Is agentic memory functioning correctly?' }]
        },
        sessionId: 'test-session-' + Date.now(),
        workspaceRoot: workspaceRoot,
        agentic: true
    };

    console.error('Executing middleware execute()...');
    let nextCalled = false;
    await middleware.execute(mockContext, async () => {
        nextCalled = true;
        // Verify that the system prompt was injected
        const sysPrompt = mockContext.request.messages.find((m: any) => m.role === 'system');
        if (sysPrompt && sysPrompt.content.includes('## 🧠 WORKSPACE MEMORY')) {
            console.error('SUCCESS: System prompt contains WORKSPACE MEMORY block.');
            console.error('Prompt Preview:', sysPrompt.content.slice(0, 500) + '...');
        } else {
            console.error('DEBUG: Response Prompt length:', sysPrompt?.content?.length || 0);
            throw new Error('System prompt MISSING workspace memory injection!');
        }
    });

    if (!nextCalled) throw new Error('Middleware failed to call next()');

    console.error('Middleware execution complete.');
    console.error('PASS: Agentic Memory Pipeline verified.');
}

main().catch(err => {
    console.error('FAIL:', err);
    process.exit(1);
});
