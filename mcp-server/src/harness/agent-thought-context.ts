import { readAntigravityThoughts } from './antigravity-reader.js';
import { readCodexThoughts } from './codex-reader.js';
import { listOpencodeSessions, openOpencodeDb, readOpencodeThoughts } from './opencode-reader.js';
import { buildThoughtDag, buildLinearThoughtDag, expandThoughtDag, type ThoughtDag } from './thought-dag.js';
import { detectThoughtSources, type ThoughtSourcesConfig } from './thought-sources.js';
import { readZedThoughtDags } from './zed-reader.js';

export interface ReadAgentThoughtContextOptions {
  workspaceRoot: string;
  homeDir?: string;
  config?: ThoughtSourcesConfig;
  maxSources?: number;
}

export async function readAgentThoughtDags(opts: ReadAgentThoughtContextOptions): Promise<ThoughtDag[]> {
  const sources = detectThoughtSources(opts);
  const dags: ThoughtDag[] = [];
  const maxSources = opts.maxSources ?? 40;

  for (const source of sources.slice(0, maxSources)) {
    try {
      if (source.kind === 'claude' && source.claudeJsonl) {
        const dag = await buildThoughtDag(source.claudeJsonl, { maxLines: 2000 });
        if (dag.nodes.length) dags.push(dag);
      } else if (source.kind === 'opencode' && source.opencodeDb && source.opencodeSessionId) {
        const db = openOpencodeDb(source.opencodeDb);
        if (!db) continue;
        try {
          const session = listOpencodeSessions(db).find(item => item.id === source.opencodeSessionId);
          const thoughts = readOpencodeThoughts(db, source.opencodeSessionId, 80);
          const dag = buildLinearThoughtDag(source.opencodeSessionId, thoughts.map(thought => ({
            id: thought.messageId,
            text: thought.text,
            timeCreated: thought.timeCreated,
          })));
          if (dag.nodes.length) {
            dag.goal = session?.title ?? dag.goal;
            dags.push(dag);
          }
        } finally {
          db.close();
        }
      } else if (source.kind === 'codex' && source.codexRollout) {
        const thoughts = await readCodexThoughts(source.codexRollout, source.label, 80);
        const dag = buildLinearThoughtDag(source.label, thoughts.map(thought => ({
          id: thought.messageId,
          text: thought.text,
          timeCreated: thought.timeCreated,
        })));
        if (dag.nodes.length) dags.push(dag);
      } else if (source.kind === 'antigravity' && source.antigravityTranscript) {
        const thoughts = readAntigravityThoughts(source.antigravityTranscript, source.label, 80);
        const dag = buildLinearThoughtDag(source.label, thoughts.map(thought => ({
          id: thought.messageId,
          text: thought.text,
          timeCreated: thought.timeCreated,
        })));
        if (dag.nodes.length) dags.push(dag);
      }
    } catch (err) {
      console.error(`[agent-thought-context] skipped ${source.kind}: ${(err as Error)?.message ?? err}`);
      continue;
    }
  }

  const zedSources = sources.filter(source => source.kind === 'zed');
  if (zedSources.length) {
    try {
      const allowed = new Set(zedSources.map(source => source.zedSessionId).filter((id): id is string => !!id));
      const dbPath = zedSources[0].zedDb;
      const zedDags = readZedThoughtDags(opts.workspaceRoot, { dbPath, limit: maxSources });
      dags.push(...(allowed.size ? zedDags.filter(dag => allowed.has(dag.sessionId)) : zedDags));
    } catch (err) {
      console.error(`[agent-thought-context] skipped zed: ${(err as Error)?.message ?? err}`);
    }
  }
  return dags;
}

export function expandAgentThoughtContext(
  dags: ThoughtDag[],
  query: string,
  maxChars = 12000,
): string {
  const terms = new Set(query.toLowerCase().match(/[\p{L}\p{N}_./\\-]{3,}/gu) ?? []);
  const ranked = dags.map((dag, index) => ({
    dag,
    index,
    score: dag.nodes.reduce((total, node) => {
      const text = node.text.toLowerCase();
      return total + Array.from(terms).reduce((nodeScore, term) => nodeScore + Number(text.includes(term)), 0);
    }, 0),
    updated: dag.nodes.at(-1)?.timestamp ?? '',
  })).sort((a, b) => b.score - a.score || b.updated.localeCompare(a.updated) || a.index - b.index);

  if (ranked.length === 0 || maxChars <= 0) return '';
  const summaries = ranked.slice(0, 4).map(({ dag }) => {
    const goal = dag.goal.replace(/\s+/g, ' ').slice(0, 180);
    return `- ${dag.sessionId}: ${goal || '(no recorded goal)'} (${dag.nodes.length} DAG nodes)`;
  });
  const header = `[Agent-thought blackboard: ${dags.length} workspace-matched sessions]\n${summaries.join('\n')}`;
  const blocks: string[] = [header];
  let remaining = maxChars - header.length - 2;
  for (const entry of ranked) {
    if (remaining <= 0) break;
    const budget = Math.min(remaining, 5000);
    const block = expandThoughtDag(entry.dag, query, budget);
    if (!block) continue;
    blocks.push(block);
    remaining -= block.length + 2;
  }
  return blocks.join('\n\n').slice(0, maxChars);
}
