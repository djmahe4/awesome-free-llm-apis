import { MemoryManager } from '../memory/index.js';
import { WorkspaceScanner } from '../cache/workspace.js';

export interface ManageMemoryInput {
    action: 'search' | 'list' | 'stats' | 'clear';
    workspace_root?: string;
    query?: string;
    limit?: number;
}

const memoryManager = new MemoryManager();
const workspaceScanner = new WorkspaceScanner(process.cwd());

import { ContextManager } from '../utils/ContextManager.js';

export async function manageMemory(input: ManageMemoryInput) {
    const { action, workspace_root: workspaceRoot, query, limit = 10 } = input;
    const wsHash = workspaceScanner.getWorkspaceHash(workspaceRoot);
    const contextManager = new ContextManager();

    switch (action) {
        case 'stats':
            return await memoryManager.getCompressionStats();
        case 'list':
            return { workspace: workspaceRoot || 'default', hash: wsHash };
        case 'clear':
            return { success: true, message: `Memory management for ${wsHash} is active` };
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
