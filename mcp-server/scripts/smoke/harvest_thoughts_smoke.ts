import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ThoughtDatasetWriter, type DatasetRow } from '../../src/harness/thought-dataset-writer.js';
import { buildThoughtDag, traceRoot, type DagNode } from '../../src/harness/thought-dag.js';
import { assignExpert } from '../../src/harness/laya-bridge.js';
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

interface HarvestResult {
  sessionId: string;
  goal: string;
  rows: DatasetRow[];
  thinkingTotal: number;
  emptyThinking: number;
  layaAssigned: number;
  fallbackAssigned: number;
}

async function harvest(): Promise<HarvestResult> {
  const dag = await buildThoughtDag(JSONL);
  const goal = dag.goal.slice(0, 200);

  const toolResultByCall = new Map<string, DagNode>();
  for (const node of dag.nodes) {
    if (node.kind === 'tool_result' && node.parent) {
      toolResultByCall.set(node.parent, node);
    }
  }

  const rows: DatasetRow[] = [];
  let thinkingTotal = 0;
  let emptyThinking = 0;
  let layaAssigned = 0;
  let fallbackAssigned = 0;
  let pendingThoughts: DagNode[] = [];

  for (const node of dag.nodes) {
    if (rows.length >= IMPORT_LIMIT) break;
    if (node.kind === 'root') { pendingThoughts = []; continue; }
    if (node.kind === 'thought') { pendingThoughts.push(node); continue; }
    if (node.kind !== 'tool_call') continue;

    const tool = node.tool ?? 'none';
    const toolResult = toolResultByCall.get(node.id);
    for (const thoughtNode of pendingThoughts) {
      thinkingTotal++;
      const text = thoughtNode.text;
      if (!text || text.length < MIN_THOUGHT_LEN) { emptyThinking++; continue; }
      if (rows.length >= IMPORT_LIMIT) break;
      const expert = await assignExpert({ thought: text, goal, tool });
      if (expert.expert_source === 'laya') layaAssigned++; else fallbackAssigned++;
      const parsed = thoughtNode.timestamp ? Date.parse(thoughtNode.timestamp) : NaN;
      rows.push({
        thought: {
          id: thoughtNode.id,
          text,
          source: 'external',
          timestamp: Number.isFinite(parsed) ? parsed : Date.now(),
        },
        tool,
        action: node.input,
        goal,
        alignment: 'aligned',
        drift_prob: 0,
        parent_thought_id: thoughtNode.parent,
        root_thought_id: traceRoot(dag, thoughtNode.id)?.id ?? null,
        depth: thoughtNode.depth,
        tool_call_id: node.toolCallId ?? null,
        result_ok: toolResult?.resultOk ?? null,
        expert_label: expert.expert,
        expert_source: expert.expert_source,
      });
    }
    pendingThoughts = [];
  }

  for (const thoughtNode of pendingThoughts) {
    if (rows.length >= IMPORT_LIMIT) break;
    thinkingTotal++;
    const text = thoughtNode.text;
    if (!text || text.length < MIN_THOUGHT_LEN) { emptyThinking++; continue; }
    const expert = await assignExpert({ thought: text, goal, tool: 'none' });
    if (expert.expert_source === 'laya') layaAssigned++; else fallbackAssigned++;
    const parsed = thoughtNode.timestamp ? Date.parse(thoughtNode.timestamp) : NaN;
    rows.push({
      thought: {
        id: thoughtNode.id,
        text,
        source: 'external',
        timestamp: Number.isFinite(parsed) ? parsed : Date.now(),
      },
      tool: 'none',
      goal,
      alignment: 'aligned',
      drift_prob: 0,
      parent_thought_id: thoughtNode.parent,
      root_thought_id: traceRoot(dag, thoughtNode.id)?.id ?? null,
      depth: thoughtNode.depth,
      expert_label: expert.expert,
      expert_source: expert.expert_source,
    });
  }

  return { sessionId: dag.sessionId, goal, rows, thinkingTotal, emptyThinking, layaAssigned, fallbackAssigned };
}

async function main(): Promise<void> {
  console.log('=== harvest: claude session -> lossless thought dag -> dataset ===');
  fs.rmSync(DATASET_DIR, { recursive: true, force: true });
  const { sessionId, goal, rows, thinkingTotal, emptyThinking, layaAssigned, fallbackAssigned } = await harvest();
  const writer = new ThoughtDatasetWriter({ outputDir: DATASET_DIR });
  for (const row of rows) await writer.append(row);
  const stat = fs.statSync(path.join(DATASET_DIR, 'thoughts.jsonl'));
  console.log(`session: ${sessionId}`);
  console.log(`goal: ${goal}`);
  console.log(`thinking nodes seen: ${thinkingTotal} (empty/short skipped: ${emptyThinking})`);
  console.log(`rows imported: ${rows.length}`);
  console.log(`expert assignment: laya=${layaAssigned} fallback=${fallbackAssigned}`);
  console.log(`dataset file: ${path.join(DATASET_DIR, 'thoughts.jsonl')} (${stat.size} bytes)`);
  if (rows.length > 0) {
    const r = rows[0];
    console.log('sample row:');
    console.log(JSON.stringify({
      thought_id: r.thought.id,
      thought_text: r.thought.text.slice(0, 120),
      tool: r.tool,
      parent_thought_id: r.parent_thought_id,
      root_thought_id: r.root_thought_id,
      depth: r.depth,
      tool_call_id: r.tool_call_id,
      result_ok: r.result_ok,
      expert_label: r.expert_label,
      expert_source: r.expert_source,
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
