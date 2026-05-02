import { WorkspaceIndexer, IndexingResult } from '../memory/indexer.js';

export interface IndexWorkspaceArgs {
    workspace_root: string;
    force?: boolean;
}

export async function indexWorkspace(args: IndexWorkspaceArgs): Promise<IndexingResult> {
    const { workspace_root, force = false } = args;
    const indexer = new WorkspaceIndexer(workspace_root);
    return await indexer.indexWorkspace(workspace_root, force);
}
