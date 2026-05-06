import { ShortTermMemory } from './short-term.js';
import { LongTermMemory } from './long-term.js';
import { vectorStore, VectorEntry } from './vector.js';
import { Sanitizer } from '../utils/Sanitizer.js';

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

    // v1.0.5: Signal-Based Vector Indexing to prevent memory pollution
    if (['auto_memory', 'store_workspace_skill', 'store_memory', 'manual_memory'].includes(toolName)) {
      try {
        const content = typeof output === 'string' ? output : JSON.stringify(output);

        // Filter: Only index high-signal content (code, paths, structured decisions)
        // Manual memory and skill storage are always considered high-signal
        const isExplicit = ['manual_memory', 'store_workspace_skill'].includes(toolName);
        const isHighSignal = isExplicit || (/`.*`|\\|\/|## |Decision:|Architecture:|Bug:|FIX:/i.test(content) &&
          !/verified|functioning correctly|success/i.test(content));

        if (!isHighSignal) return;

        const wsHash = input?._ws || input?.ws || (input?.workspace_root ? Buffer.from(input.workspace_root).toString('base64').slice(0, 8) : null);

        if (wsHash) {
          const vectorKey = `vector:${wsHash}:${key}`;
          const hash = vectorStore.calculateHash(content);

          // Check if already indexed and unchanged
          const existingHash = await this.longTerm.load(`${vectorKey}:hash`);
          if (existingHash === hash) return;

          const sanitizedContent = Sanitizer.sanitize(content);
          const sanitizedMetadata = Sanitizer.sanitizeObject({ tool: toolName, input, ws: wsHash });

          await vectorStore.upsert(wsHash, {
            id: key,
            content: sanitizedContent,
            metadata: sanitizedMetadata,
            contentHash: hash,
            timestamp: Date.now()
          });

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
    // v1.0.5: Semantic-First Search to eliminate naive duplicate leakage
    if (!query) {
      // If no query, return all entries for this workspace (excluding vector keys)
      const allKeys = await this.longTerm.list();
      const results: unknown[] = [];
      for (const key of allKeys) {
        if (key.startsWith('vector:')) continue;
        if (key.includes(`"_ws":"${workspaceHash}"`) || key.includes(`"ws":"${workspaceHash}"`) || key.includes(`_ws:${workspaceHash}`)) {
          results.push(await this.longTerm.load(key));
        }
      }
      return results;
    }

    // 1. Priority: Semantic Search (Precision retrieval)
    const semanticResults = await this.semanticSearch(workspaceHash, query);

    // 2. Deduplicate by content hash to avoid redundancy
    const uniqueResults: unknown[] = [];
    const seenHashes = new Set<string>();

    for (const res of semanticResults) {
      // Extract hash if it's a VectorEntry or has a contentHash field
      const hash = (res as any)?.contentHash || (typeof res === 'string' ? vectorStore.calculateHash(res) : null);
      if (hash && !seenHashes.has(hash)) {
        seenHashes.add(hash);
        uniqueResults.push(res);
      }
    }

    return uniqueResults;
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
