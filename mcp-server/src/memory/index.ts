import { ShortTermMemory } from './short-term.js';
import { LongTermMemory } from './long-term.js';
import { vectorStore, VectorEntry } from './vector.js';

export { ShortTermMemory } from './short-term.js';
export { LongTermMemory } from './long-term.js';

interface CompressionStat {
  tool: string;
  original: number;
  compressed: number;
  ratio: number;
  timestamp: number;
}

export class MemoryManager {
  shortTerm: ShortTermMemory;
  longTerm: LongTermMemory;

  constructor(storePath?: string) {
    this.shortTerm = new ShortTermMemory();
    this.longTerm = new LongTermMemory(storePath);
  }

  async storeToolOutput(toolName: string, input: any, output: any): Promise<void> {
    const key = `tool:${toolName}:${JSON.stringify(input)}`;
    this.shortTerm.set(key, output);
    await this.longTerm.save(key, output);

    // v1.0.5: Vector indexing for semantic search
    if (['auto_memory', 'store_workspace_skill', 'store_memory'].includes(toolName)) {
      try {
        const content = typeof output === 'string' ? output : JSON.stringify(output);
        const wsHash = input?._ws || input?.ws || (input?.workspace_root ? Buffer.from(input.workspace_root).toString('base64').slice(0, 8) : null);

        if (wsHash) {
          const vectorKey = `vector:${wsHash}:${key}`;
          const hash = vectorStore.calculateHash(content);

          // Check if already indexed and unchanged (using longTerm as a cache for hash)
          const existingHash = await this.longTerm.load(`${vectorKey}:hash`);
          if (existingHash === hash) return;

          await vectorStore.upsert(wsHash, {
            id: key,
            content,
            metadata: { tool: toolName, input, ws: wsHash },
            contentHash: hash,
            timestamp: Date.now()
          });

          // Store hash only in longTerm to avoid re-indexing
          await this.longTerm.save(`${vectorKey}:hash`, hash);
        }
      } catch (err) {
        console.error(`[MemoryManager] Vector indexing failed: ${err}`);
      }
    }
  }

  async getToolOutput(toolName: string, input: unknown): Promise<unknown | undefined> {
    const key = `tool:${toolName}:${JSON.stringify(input)}`;
    const cached = this.shortTerm.get(key);
    if (cached !== undefined) return cached;
    return this.longTerm.load(key);
  }

  async search(workspaceHash: string, query?: string): Promise<unknown[]> {
    const allKeys = await this.longTerm.list();
    const results: unknown[] = [];

    for (const key of allKeys) {
      if (key.startsWith('vector:')) continue;
      
      if (key.includes(`"_ws":"${workspaceHash}"`) || key.includes(`"ws":"${workspaceHash}"`) || key.includes(`_ws:${workspaceHash}`)) {
        const val = await this.longTerm.load(key);
        if (!query || JSON.stringify(val).toLowerCase().includes(query.toLowerCase())) {
          results.push(val);
        }
      }
    }

    // If query exists and results are low, try semantic search
    if (query && results.length < 3) {
      const semanticResults = await this.semanticSearch(workspaceHash, query);
      // Merge and de-dupe
      for (const res of semanticResults) {
        if (!results.find(r => JSON.stringify(r) === JSON.stringify(res))) {
          results.push(res);
        }
      }
    }

    return results;
  }

  async semanticSearch(workspaceHash: string, query: string): Promise<unknown[]> {
    try {
      const matches = await vectorStore.search(workspaceHash, query);
      return matches.map(m => {
        try {
          return JSON.parse(m.content);
        } catch {
          return m.content;
        }
      });
    } catch (err) {
      console.error(`[MemoryManager] Semantic search failed: ${err}`);
      return [];
    }
  }

  async storeCompressionStats(original: number, compressed: number, tool: string): Promise<void> {
    const stats = (await this.longTerm.load('compression:stats') ?? []) as CompressionStat[];
    stats.push({ tool, original, compressed, ratio: compressed / original, timestamp: Date.now() });
    await this.longTerm.save('compression:stats', stats);
  }

  async getCompressionStats(): Promise<Array<{ tool: string; original: number; compressed: number; ratio: number }>> {
    const stats = (await this.longTerm.load('compression:stats') ?? []) as CompressionStat[];
    return stats.map(({ tool, original, compressed, ratio }) => ({ tool, original, compressed, ratio }));
  }

  async clear(workspaceHash: string): Promise<void> {
    const allKeys = await this.longTerm.list();
    for (const key of allKeys) {
      if (key.includes(`"_ws":"${workspaceHash}"`) || key.includes(`"ws":"${workspaceHash}"`) || key.includes(`_ws:${workspaceHash}`) || key.startsWith(`vector:${workspaceHash}:`)) {
        await this.longTerm.delete(key);
      }
    }
    await vectorStore.deleteIndex(workspaceHash);
    await this.longTerm.flush();
  }

  async flush(): Promise<void> {
    await this.longTerm.flush();
  }
}

export const memoryManager = new MemoryManager();
