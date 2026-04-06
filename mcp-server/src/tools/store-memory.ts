import { memoryManager } from '../memory/index.js';
import { WorkspaceScanner } from '../cache/workspace.js';

export interface StoreMemoryInput {
    key: string;
    content: string;
    workspace_root?: string;
}

const workspaceScanner = new WorkspaceScanner(process.cwd());

export async function storeMemory(input: StoreMemoryInput) {
    const { key, content, workspace_root: workspaceRoot } = input;
    const wsHash = workspaceScanner.getWorkspaceHash(workspaceRoot);

    await memoryManager.storeToolOutput('store_memory', {
        key,
        _ws: wsHash
    }, content);

    memoryManager.flush();

    return {
        success: true,
        message: `Successfully stored memory for key '${key}' in workspace hash ${wsHash}`,
        stored_bytes: Buffer.byteLength(content, 'utf8')
    };
}
