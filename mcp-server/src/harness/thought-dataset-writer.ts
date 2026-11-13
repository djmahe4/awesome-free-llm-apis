import fs from 'node:fs';
import path from 'node:path';
import type { ThoughtBundle } from './context-injection-hook.js';
import type { AlignmentResult } from './laya-bridge.js';

const TOOL_TO_EXPERT: Record<string, string> = {
  reverse_tool: 'reverse',
  cyber_tool: 'cyber',
  browser_tool: 'browser',
  movie_tool: 'media',
  coding_agents: 'coding',
  manage_memory: 'memory',
  quantum_tool: 'quantum',
  use_free_llm: 'general',
};
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface DatasetRow {
  thought: ThoughtBundle;
  tool: string;
  action?: string;
  goal: string;
  alignment: AlignmentResult;
  drift_prob: number;
  expert_label?: string;
  circuit_confidence?: number | null;
  parent_thought_id?: string | null;
  root_thought_id?: string | null;
  depth?: number;
  tool_call_id?: string | null;
  result_ok?: boolean | null;
  expert_source?: 'laya' | 'fallback';
}

export interface ReplayThoughtRow {
  thoughtId: string;
  thoughtText: string;
  tool: string;
  action?: string;
}

export class ThoughtDatasetWriter {
  private filePath: string;

  constructor(opts: { outputDir: string; filename?: string }) {
    fs.mkdirSync(opts.outputDir, { recursive: true });
    this.filePath = path.join(opts.outputDir, opts.filename ?? 'thoughts.jsonl');
  }

  async append(row: DatasetRow): Promise<void> {
    try {
      const stat = await fs.promises.stat(this.filePath);
      if (stat.size > MAX_FILE_BYTES) {
        await fs.promises.rename(this.filePath, this.filePath + `.${Date.now()}.bak`);
      }
    } catch {
      // File does not exist yet or cannot be stated; proceed to append
    }

    const jsonlRow = {
      thought_id: row.thought.id,
      thought_text: row.thought.text,
      thought_source: row.thought.source,
      timestamp: row.thought.timestamp,
      tool: row.tool,
      action: row.action,
      goal: row.goal,
      alignment: row.alignment,
      drift_prob: row.drift_prob,
      expert_label: row.expert_label ?? ThoughtDatasetWriter.expertLabel(row.tool),
      circuit_confidence: row.circuit_confidence ?? null,
      parent_thought_id: row.parent_thought_id ?? null,
      root_thought_id: row.root_thought_id ?? null,
      depth: row.depth ?? null,
      tool_call_id: row.tool_call_id ?? null,
      result_ok: row.result_ok ?? null,
      expert_source: row.expert_source ?? 'fallback',
    };
    await fs.promises.appendFile(this.filePath, JSON.stringify(jsonlRow) + '\n', 'utf8');
  }

  static expertLabel(tool: string): string {
    return TOOL_TO_EXPERT[tool] ?? 'general';
  }

  static readRecent(outputDir: string, runId: string, limit: number): ReplayThoughtRow[] {
    try {
      const raw = fs.readFileSync(path.join(outputDir, 'thoughts.jsonl'), 'utf8');
      const rows: any[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {
        }
      }
      return rows
        .filter(r => typeof r.thought_id === 'string' && r.thought_id.startsWith(`${runId}:`))
        .slice(-limit)
        .map(r => ({
          thoughtId: r.thought_id,
          thoughtText: String(r.thought_text ?? ''),
          tool: String(r.tool ?? 'unknown'),
          action: r.action,
        }));
    } catch {
      return [];
    }
  }
}
