import { memoryManager } from '../memory/index.js';
import { WorkspaceScanner } from '../cache/workspace.js';
import { ContextManager } from '../utils/ContextManager.js';

export interface ManageMemoryInput {
    action: 'search' | 'list' | 'stats' | 'clear';
    workspace_root?: string;
    query?: string;
    limit?: number;
}

const workspaceScanner = new WorkspaceScanner(process.cwd());

export async function manageMemory(input: ManageMemoryInput) {
    const { action, workspace_root: workspaceRoot, query, limit = 10 } = input;
    const wsHash = await workspaceScanner.getWorkspaceHash(workspaceRoot);
    const contextManager = new ContextManager();

    switch (action) {
        case 'stats':
            return await memoryManager.getCompressionStats();
        case 'list':
            return { workspace: workspaceRoot || 'default', hash: wsHash };
        case 'clear':
            await memoryManager.clear(wsHash);
            return { success: true, message: `Cleared memory for workspace ${wsHash}` };
        case 'search': {
            const allResults = await memoryManager.search(wsHash, query);
            // Apply hard count limit
            let results = allResults.slice(0, limit);

            // Apply token limit to prevent pipeline overload
            const MAX_MEMORY_TOKENS = 8000;
            let currentTokens = contextManager.countStringTokens(JSON.stringify(results));

            if (currentTokens > MAX_MEMORY_TOKENS) {
                while (results.length > 1 && currentTokens > MAX_MEMORY_TOKENS) {
                    results.pop(); // Remove largest or last item
                    currentTokens = contextManager.countStringTokens(JSON.stringify(results));
                }
                return {
                    results,
                    meta: {
                        total_found: allResults.length,
                        note: `Truncated to ${results.length} results (${currentTokens} tokens) to prevent context overflow.`
                    }
                };
            }

            return {
                results,
                meta: { total_found: allResults.length }
            };
        }
        default:
            throw new Error(`Unsupported action: ${action}`);
    }
}
