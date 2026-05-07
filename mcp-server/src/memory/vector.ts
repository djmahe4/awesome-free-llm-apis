import { pipeline } from '@huggingface/transformers';
import crypto from 'crypto';
import { LocalIndex, QueryResult } from 'vectra';
import path from 'path';
import fs from 'fs/promises';

export interface VectorEntry {
    id: string;
    content: string;
    metadata: any;
    embedding?: number[]; // Optional now as Vectra stores it
    contentHash: string;
    timestamp: number;
}

export class VectorStore {
    private embedder: any = null;
    private modelName = 'Xenova/bge-small-en-v1.5';
    private storageRoot: string;

    constructor(storageRoot = './data/vector-indices') {
        this.storageRoot = storageRoot;
    }

    private async getEmbedder() {
        if (!this.embedder) {
            this.embedder = await pipeline('feature-extraction', this.modelName);
        }
        return this.embedder;
    }

    private indexPromises: Map<string, Promise<LocalIndex>> = new Map();

    private async getIndex(workspaceHash: string): Promise<LocalIndex> {
        if (!this.indexPromises.has(workspaceHash)) {
            this.indexPromises.set(workspaceHash, (async () => {
                const indexPath = path.join(this.storageRoot, workspaceHash);
                const index = new LocalIndex(indexPath);

                if (!(await index.isIndexCreated())) {
                    await fs.mkdir(indexPath, { recursive: true });
                    await index.createIndex();
                }

                return index;
            })());
        }
        return await this.indexPromises.get(workspaceHash)!;
    }

    async generateEmbedding(text: string): Promise<number[]> {
        const embedder = await this.getEmbedder();
        const output = await embedder(text, { pooling: 'mean', normalize: true });
        return Array.from(output.data);
    }

    calculateHash(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    async upsert(workspaceHash: string, entry: VectorEntry): Promise<void> {
        const index = await this.getIndex(workspaceHash);
        const embedding = entry.embedding || await this.generateEmbedding(entry.content);

        // Vectra uses metadata to store the entry details
        // v1.0.5: Use upsertItem and endUpdate to ensure persistence
        await index.beginUpdate();
        try {
            await index.upsertItem({
                id: entry.id, // CRITICAL: Pass ID at top level for vectra to replace existing items
                vector: embedding,
                metadata: {
                    content: entry.content,
                    contentHash: entry.contentHash,
                    timestamp: entry.timestamp,
                    ...entry.metadata
                }
            });
            await index.endUpdate();
        } catch (error) {
            index.cancelUpdate();
            throw error;
        }
    }

    async search(workspaceHash: string, query: string, limit: number = 5): Promise<VectorEntry[]> {
        const index = await this.getIndex(workspaceHash);
        const queryEmbedding = await this.generateEmbedding(query);

        let results: QueryResult<any>[];
        try {
            // Try hybrid search first (BM25 + Semantic)
            // Signature: (vector, query, topK, filter, isBm25)
            results = await index.queryItems(queryEmbedding, query, limit, undefined, true);
        } catch (err) {
            // Fallback to pure semantic search if BM25 fails (e.g. not enough documents for winkBM25S)
            results = await index.queryItems(queryEmbedding, query, limit, undefined, false);
        }

        return results.map((res: QueryResult<any>) => ({
            id: res.item.id as string,
            content: res.item.metadata.content as string,
            contentHash: res.item.metadata.contentHash as string,
            timestamp: res.item.metadata.timestamp as number,
            metadata: res.item.metadata,
            score: res.score
        } as any));
    }

    async deleteIndex(workspaceHash: string): Promise<void> {
        const indexPath = path.join(this.storageRoot, workspaceHash);
        await fs.rm(indexPath, { recursive: true, force: true });
        this.indexPromises.delete(workspaceHash);
    }
}

export const vectorStore = new VectorStore();
