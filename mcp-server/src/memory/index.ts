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
    if (['auto_memory', 'store_workspace_skill', 'manual_memory'].includes(toolName)) {
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

  compareFilesLineByLineCosine(
    fileAContent: string,
    fileBContent: string,
    threshold: number = 0.82
  ): {
    averageSimilarity: number;
    similarLines: Array<{ lineA: number; lineB: number; similarity: number }>;
    isSimilar: boolean;
    summary: string;
  } {
    const linesA = fileAContent.split('\n');
    const linesB = fileBContent.split('\n');
    const docFreq = new Map<string, number>();
    const allLines = [...linesA, ...linesB];

    const tokenize = (line: string): string[] =>
      line.toLowerCase().match(/[a-z0-9_]+/g) || [];

    allLines.forEach((line) => {
      const terms = tokenize(line);
      const unique = new Set(terms);
      unique.forEach((term) => docFreq.set(term, (docFreq.get(term) || 0) + 1));
    });

    const totalDocs = Math.max(1, allLines.length);
    const idf = new Map<string, number>();
    for (const [term, df] of docFreq.entries()) {
      idf.set(term, Math.log((1 + totalDocs) / (1 + df)) + 1);
    }

    const vectorize = (tokens: string[]): Map<string, number> => {
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      const vec = new Map<string, number>();
      for (const [term, count] of tf.entries()) {
        vec.set(term, count * (idf.get(term) || 1));
      }
      return vec;
    };

    const cosine = (a: Map<string, number>, b: Map<string, number>): number => {
      let dot = 0;
      let normA = 0;
      let normB = 0;
      for (const val of a.values()) normA += val * val;
      for (const val of b.values()) normB += val * val;
      for (const [term, val] of a.entries()) {
        dot += val * (b.get(term) || 0);
      }
      if (normA === 0 || normB === 0) return 0;
      return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    };

    const vectorsA = linesA.map((line) => vectorize(tokenize(line)));
    const vectorsB = linesB.map((line) => vectorize(tokenize(line)));
    const matches: Array<{ lineA: number; lineB: number; similarity: number }> = [];
    let simSum = 0;
    let comparisons = 0;

    for (let i = 0; i < vectorsA.length; i++) {
      let best = { lineB: -1, similarity: 0 };
      for (let j = 0; j < vectorsB.length; j++) {
        const s = cosine(vectorsA[i], vectorsB[j]);
        comparisons++;
        simSum += s;
        if (s > best.similarity) best = { lineB: j, similarity: s };
      }
      if (best.similarity >= threshold) {
        matches.push({ lineA: i + 1, lineB: best.lineB + 1, similarity: Number(best.similarity.toFixed(3)) });
      }
    }

    const avg = comparisons > 0 ? simSum / comparisons : 0;
    const summary = matches.length > 0
      ? `Detected ${matches.length} highly similar line pairs (threshold ${threshold}).`
      : `No high-similarity line matches found (threshold ${threshold}).`;

    return {
      averageSimilarity: Number(avg.toFixed(4)),
      similarLines: matches,
      isSimilar: avg >= threshold || matches.length > 0,
      summary
    };
  }

  async updateWorkspaceMemoryForSimilarFiles(
    workspaceHash: string,
    filePath: string,
    previousContent: string,
    currentContent: string,
    threshold: number = 0.82
  ): Promise<void> {
    const comparison = this.compareFilesLineByLineCosine(previousContent, currentContent, threshold);
    if (!comparison.isSimilar) return;

    const previousLines = previousContent.split('\n');
    const differentLines = currentContent
      .split('\n')
      .map((line, idx) => ({ line, idx }))
      .filter(({ line, idx }) => line !== (previousLines[idx] || ''))
      .slice(0, 15)
      .map(({ line, idx }) => `L${idx + 1}: ${line}`);

    const summary = {
      type: 'similar-file-diff-summary',
      path: filePath,
      averageSimilarity: comparison.averageSimilarity,
      similarLines: comparison.similarLines.slice(0, 20),
      diffPreview: differentLines
    };

    await this.storeToolOutput('auto_memory', { _ws: workspaceHash, path: filePath }, summary);
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
