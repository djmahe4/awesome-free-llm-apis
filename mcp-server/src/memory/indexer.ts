import fs from 'fs/promises';
import path from 'path';
import { vectorStore } from './vector.js';
import { memoryManager } from './index.js';
import { WorkspaceScanner } from '../cache/workspace.js';
import { WorkspaceWalker } from '../middleware/agentic/workspace-walker.js';
import { Sanitizer } from '../utils/Sanitizer.js';

export interface IndexingResult {
    totalFiles: number;
    indexedFiles: number;
    skippedFiles: number;
    errors: number;
}

export class WorkspaceIndexer {
    private workspaceScanner: WorkspaceScanner;

    constructor(workspaceRoot: string) {
        this.workspaceScanner = new WorkspaceScanner(workspaceRoot);
    }

    /**
     * Proactively index the workspace files.
     * Uses hash-based tracking to avoid redundant indexing.
     */
    async indexWorkspace(workspaceRoot: string, force: boolean = false): Promise<IndexingResult> {
        const wsHash = await this.workspaceScanner.getWorkspaceHash(workspaceRoot);
        
        if (force) {
            await vectorStore.deleteIndex(wsHash);
            // Also clear the hash cache in long-term memory for this workspace
            const allKeys = await memoryManager.longTerm.list();
            for (const key of allKeys) {
                if (key.startsWith(`file:${wsHash}:`) && key.endsWith(':hash')) {
                    await memoryManager.longTerm.delete(key);
                }
            }
        }

        const result: IndexingResult = { totalFiles: 0, indexedFiles: 0, skippedFiles: 0, errors: 0 };

        // 1. Get all relevant files
        const files = await WorkspaceWalker.findRelevantFiles(workspaceRoot, [], 1000);
        result.totalFiles = files.length;

        // 2. Process files sequentially to avoid race conditions in Vectra/Memory
        for (const file of files) {
            try {
                const relativePath = path.relative(workspaceRoot, file);
                const content = await fs.readFile(file, 'utf-8');
                const contentHash = vectorStore.calculateHash(content);

                const vectorKey = `file:${wsHash}:${relativePath}`;
                
                // Check if already indexed and unchanged (using memoryManager's longTerm cache)
                const existingHash = await memoryManager.longTerm.load(`${vectorKey}:hash`);
                if (existingHash === contentHash && !force) {
                    result.skippedFiles++;
                    continue;
                }

                // 3. Upsert to Vectra
                const sanitizedContent = Sanitizer.sanitize(content);
                await vectorStore.upsert(wsHash, {
                    id: vectorKey,
                    content: `File: ${relativePath}\n\n${sanitizedContent.slice(0, 5000)}`, // Cap content for indexing
                    metadata: { 
                        type: 'file',
                        path: relativePath,
                        ws: wsHash 
                    },
                    contentHash,
                    timestamp: Date.now()
                });

                // 4. Update hash cache
                await memoryManager.longTerm.save(`${vectorKey}:hash`, contentHash);
                result.indexedFiles++;
            } catch (err) {
                console.error(`[WorkspaceIndexer] Failed to index ${file}: ${err}`);
                result.errors++;
            }
        }

        await memoryManager.flush();
        return result;
    }
}
