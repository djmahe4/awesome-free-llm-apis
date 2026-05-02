import { pipeline } from '@huggingface/transformers';
import crypto from 'crypto';
import { LocalIndex } from 'vectra';
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
    private indices: Map<string, LocalIndex> = new Map();
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

    private async getIndex(workspaceHash: string): Promise<LocalIndex> {
        if (!this.indices.has(workspaceHash)) {
            const indexPath = path.join(this.storageRoot, workspaceHash);
            const index = new LocalIndex(indexPath);

            if (!(await index.isIndexCreated())) {
                await fs.mkdir(indexPath, { recursive: true });
                await index.createIndex();
            }

            this.indices.set(workspaceHash, index);
        }
        return this.indices.get(workspaceHash)!;
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
        await index.insertItem({
            vector: embedding,
            metadata: {
                id: entry.id,
                content: entry.content,
                contentHash: entry.contentHash,
                timestamp: entry.timestamp,
                ...entry.metadata
            }
        });
    }

    async search(workspaceHash: string, query: string, limit: number = 5): Promise<VectorEntry[]> {
        const index = await this.getIndex(workspaceHash);
        const queryEmbedding = await this.generateEmbedding(query);

        const results = await index.queryItems(queryEmbedding, '', limit);

        return results.map(res => ({
            id: res.item.metadata.id as string,
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
        this.indices.delete(workspaceHash);
    }
}

export const vectorStore = new VectorStore();
