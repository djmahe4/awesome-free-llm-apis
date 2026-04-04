import { ShortTermMemory } from './short-term.js';
import { LongTermMemory } from './long-term.js';

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

  async storeToolOutput(toolName: string, input: unknown, output: unknown): Promise<void> {
    const key = `tool:${toolName}:${JSON.stringify(input)}`;
    this.shortTerm.set(key, output);
    await this.longTerm.save(key, output);
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
      if (key.includes(`"_ws":"${workspaceHash}"`) || key.includes(`"ws":"${workspaceHash}"`) || key.includes(`_ws:${workspaceHash}`)) {
        const val = await this.longTerm.load(key);
        if (!query || JSON.stringify(val).toLowerCase().includes(query.toLowerCase())) {
          results.push(val);
        }
      }
    }
    return results;
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
      if (key.includes(`"_ws":"${workspaceHash}"`) || key.includes(`"ws":"${workspaceHash}"`) || key.includes(`_ws:${workspaceHash}`)) {
        await this.longTerm.delete(key);
      }
    }
    this.longTerm.flush();
  }

  flush(): void {
    this.longTerm.flush();
  }
}

export const memoryManager = new MemoryManager();
