import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ThoughtDatasetWriter, type DatasetRow } from '../../src/harness/thought-dataset-writer.js';
import { HarnessStore } from '../../src/harness/store.js';
import { checkThoughtDeviation } from '../../src/harness/runner.js';
import type { HarnessRun } from '../../src/harness/types.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HOME = os.homedir();
const SESSION_DIR = path.join(HOME, '.claude', 'projects', 'c--Users-mahes-OneDrive-Desktop-Python-Projects-awesome-free-llm-apis');
const JSONL = process.argv[2] ?? path.join(SESSION_DIR, '5b0dcfcb-8e14-4a80-9366-fe5e96d2080f.jsonl');
const DATASET_DIR = path.join(REPO_ROOT, 'scratch', 'phase9', 'smoke-thought-dataset');
const STORE_DIR = path.join(REPO_ROOT, 'scratch', 'phase9', 'smoke-store');
const IMPORT_LIMIT = Number(process.argv[3] ?? '150');
const MIN_THOUGHT_LEN = 40;
const THOUGHT_CAP = 600;

function shortInput(input: unknown): string {
  try {
    const s = JSON.stringify(input ?? {});
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
  } catch {
    return '';
  }
}

async function harvest(): Promise<{ sessionId: string; goal: string; rows: DatasetRow[]; thinkingTotal: number; emptyThinking: number }> {
  const rl = readline.createInterface({ input: fs.createReadStream(JSONL, 'utf8'), crlfDelay: Infinity });
  let sessionId = path.basename(JSONL, '.jsonl');
  let goal = '';
  const rows: DatasetRow[] = [];
  let thinkingTotal = 0;
  let emptyThinking = 0;
  let n = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    if (typeof rec?.sessionId === 'string') sessionId = rec.sessionId;
    const msg = rec?.message;
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role;
    if (role === 'user' && !goal) {
      const c = msg.content;
      const text = typeof c === 'string' ? c : Array.isArray(c)
        ? c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join(' ')
        : '';
      const noise =
        text.includes('<command-message>') || text.includes('<command-name>') ||
        text.includes('Base directory for this skill') || text.includes('system-reminder') ||
        text.startsWith('<') || text.startsWith('Caveat:');
      if (text.trim() && !noise) goal = text.trim().slice(0, 200);
      continue;
    }
    if (role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const toolUses = msg.content.filter((b: any) => b?.type === 'tool_use');
    const toolName = toolUses[0]?.name ?? 'none';
    const action = toolUses.length > 0 ? shortInput(toolUses[0]?.input) : undefined;
    for (const block of msg.content) {
      if (block?.type !== 'thinking') continue;
      thinkingTotal++;
      const text = typeof block.thinking === 'string' ? block.thinking.trim() : '';
      if (!text || text.length < MIN_THOUGHT_LEN) { emptyThinking++; continue; }
      if (rows.length >= IMPORT_LIMIT) break;
      n++;
      rows.push({
        thought: { id: `${sessionId}:${n}`, text: text.slice(0, THOUGHT_CAP), source: 'external', timestamp: rec.timestamp ?? new Date().toISOString() },
        tool: toolName,
        action,
        goal,
        alignment: 'aligned',
        drift_prob: 0,
      });
    }
    if (rows.length >= IMPORT_LIMIT) break;
  }
  return { sessionId, goal, rows, thinkingTotal, emptyThinking };
}

async function main(): Promise<void> {
  console.log('=== harvest: claude session -> thought dataset ===');
  const { sessionId, goal, rows, thinkingTotal, emptyThinking } = await harvest();
  const writer = new ThoughtDatasetWriter({ outputDir: DATASET_DIR });
  for (const row of rows) await writer.append(row);
  const stat = fs.statSync(path.join(DATASET_DIR, 'thoughts.jsonl'));
  console.log(`session: ${sessionId}`);
  console.log(`goal: ${goal}`);
  console.log(`thinking blocks seen: ${thinkingTotal} (empty/short skipped: ${emptyThinking})`);
  console.log(`rows imported: ${rows.length}`);
  console.log(`dataset file: ${path.join(DATASET_DIR, 'thoughts.jsonl')} (${stat.size} bytes)`);
  if (rows.length > 0) {
    console.log('sample row:');
    console.log(JSON.stringify({
      thought_id: rows[0].thought.id,
      thought_text: rows[0].thought.text.slice(0, 120),
      tool: rows[0].tool,
      expert_label: ThoughtDatasetWriter.expertLabel(rows[0].tool),
    }, null, 2));
  }

  console.log('\n=== replay: checkThoughtDeviation on truncated trace ===');
  process.env.THOUGHT_DATASET_DIR = DATASET_DIR;
  const replayRows = ThoughtDatasetWriter.readRecent(DATASET_DIR, sessionId, 3);
  console.log(`readRecent(${sessionId}, 3) -> ${replayRows.length} rows`);
  for (const r of replayRows) console.log(`  trail row: [${r.tool}] ${r.thoughtText.slice(0, 90)}…`);

  const store = new HarnessStore(sessionId, STORE_DIR);
  await store.appendTrace({ runId: sessionId, role: 'researcher', type: 'tool_result', data: { callId: 's0:researcher', ok: true } });
  await store.appendTrace({ runId: sessionId, role: 'researcher', type: 'tool_result', data: { callId: 's1:researcher', ok: true } });
  await store.appendTrace({ runId: sessionId, role: 'top_level', type: 'trace_truncated', data: { reason: 'max file bytes' } });

  const run = { runId: sessionId } as HarnessRun;
  const result = await checkThoughtDeviation(store, run, 'researcher', goal || 'smoke goal', 'Write the final research report markdown', 'smoke:1');
  console.log(`validation result: ${JSON.stringify(result)}`);

  const trace = await store.readTrace();
  const dev = trace.filter(e => e.type === 'deviation');
  console.log('deviation trace events:');
  for (const e of dev) console.log(' ', JSON.stringify(e.data));
  console.log('\n=== done ===');
}

main().catch(err => { console.error(err); process.exit(1); });
