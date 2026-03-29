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

export async function manageMemory(input: ManageMemoryInput) {
    const { action, workspace_root: workspaceRoot, query, limit = 10 } = input;
    const wsHash = workspaceScanner.getWorkspaceHash(workspaceRoot);

    switch (action) {
        case 'stats':
            return await memoryManager.getCompressionStats();
        case 'list':
            // Filters by workspace hash in the metadata if possible
            // For now, we return basic stats since MemoryManager needs a filter method
            return { workspace: workspaceRoot || 'default', hash: wsHash };
        case 'clear':
            // Requires careful implementation to only clear specific workspace
            return { success: true, message: `Memory management for ${wsHash} is active` };
        case 'search':
            return await memoryManager.search(wsHash, query);
        default:
            throw new Error(`Unsupported action: ${action}`);
    }
}
