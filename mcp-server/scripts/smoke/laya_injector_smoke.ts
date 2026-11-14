import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectThoughtSources } from '../../src/harness/thought-sources.js';
import { readCodexThoughts } from '../../src/harness/codex-reader.js';
import { readAntigravityThoughts } from '../../src/harness/antigravity-reader.js';
import { openOpencodeDb, readOpencodeThoughts } from '../../src/harness/opencode-reader.js';
import {
  ASSUMPTIONS_HEADING,
  QUESTIONS_HEADING,
  appendAgentAssumptions,
  buildResumeFeedback,
  decideForward,
  drainMessages,
  peekMessages,
  queueMessage,
  readAgentQuestions,
  recordAgentQuestions,
  removeConsumedQuestions,
} from '../../src/harness/laya-injector.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

async function main(): Promise<void> {
  console.log('=== laya injector smoke ===');

  console.log('\n-- 1. thought source auto-detect (claude + opencode + codex + antigravity) --');
  const sources = detectThoughtSources({ workspaceRoot: REPO_ROOT });
  const byKind = (kind: string) => sources.filter(s => s.kind === kind).length;
  console.log(`detected ${sources.length} sources (claude=${byKind('claude')}, opencode=${byKind('opencode')}, codex=${byKind('codex')}, antigravity=${byKind('antigravity')})`);
  for (const s of sources.slice(0, 12)) {
    console.log(`  [${s.kind}] ${s.label} title="${(s.title ?? '').slice(0, 60)}"`);
  }

  console.log('\n-- 2. opencode thoughts (first session) --');
  const oc = sources.find(s => s.kind === 'opencode' && s.opencodeDb && s.opencodeSessionId);
  if (oc) {
    const db = openOpencodeDb(oc.opencodeDb!);
    if (db) {
      const thoughts = readOpencodeThoughts(db, oc.opencodeSessionId!, 5);
      console.log(`readOpencodeThoughts(${oc.opencodeSessionId!.slice(0, 12)}, 5) -> ${thoughts.length}`);
      for (const t of thoughts) console.log(`  thought: ${t.text.slice(0, 100)}`);
    } else {
      console.log('db open failed (locked?)');
    }
  } else {
    console.log('no opencode source found');
  }

  console.log('\n-- 2b. codex thoughts (first session) --');
  const cx = sources.find(s => s.kind === 'codex' && s.codexRollout);
  if (cx) {
    const thoughts = await readCodexThoughts(cx.codexRollout!, cx.label, 5);
    console.log(`readCodexThoughts(${cx.label}, 5) -> ${thoughts.length}`);
    for (const t of thoughts) console.log(`  thought: ${t.text.slice(0, 100)}`);
  } else {
    console.log('no codex source found');
  }

  console.log('\n-- 2c. antigravity thoughts (first session) --');
  const ag = sources.find(s => s.kind === 'antigravity' && s.antigravityTranscript);
  if (ag) {
    const thoughts = readAntigravityThoughts(ag.antigravityTranscript!, ag.label, 5);
    console.log(`readAntigravityThoughts(${ag.label}, 5) -> ${thoughts.length}`);
    for (const t of thoughts) console.log(`  thought: ${t.text.slice(0, 100)}`);
  } else {
    console.log('no antigravity source found');
  }

  console.log('\n-- 3. decideForward AND-gate --');
  const forward = await decideForward('the tests fail after the edit, likely regression', {
    fetchImpl: (async () => new Response(JSON.stringify({ answers: { forward: { choice: 'forward' } } }), { status: 200 })) as typeof fetch,
  });
  console.log(`keyword+laya: ${forward.decision} (${forward.matchedKeywords.join(',')})`);
  const held = await decideForward('tests fail, refactor the module', {
    fetchImpl: (async () => new Response(JSON.stringify({ answers: { forward: { choice: 'hold' } } }), { status: 200 })) as typeof fetch,
  });
  console.log(`keyword pass + laya hold: ${held.decision}`);
  const blocked = await decideForward('looks good to me, proceed', {});
  console.log(`no keyword: ${blocked.decision} (${blocked.reason})`);
  const offline = await decideForward('error: module not found', {});
  console.log(`laya offline: ${offline.decision} (${offline.reason})`);

  console.log('\n-- 4. queue -> peek -> drain -> assumptions/feedback --');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-smoke-'));
  const tasksPath = path.join(ws, 'tasks.md');
  fs.writeFileSync(tasksPath, '# Tasks\n\n- [ ] fix the parser\n', 'utf8');
  queueMessage(ws, { sessionId: 's1', source: 'claude:smoke', text: 'the parser test breaks on empty input', decision: 'forward', keywords: ['breaks'], queuedAt: new Date().toISOString() });
  queueMessage(ws, { sessionId: 's1', source: 'opencode:smoke', text: 'assumption: fs.writeSync is atomic', decision: 'keyword_only', keywords: ['assumption'], queuedAt: new Date().toISOString() });
  console.log(`peek: ${peekMessages(ws).length} queued`);
  const drained = drainMessages(ws);
  console.log(`drain: ${drained.length} drained, queue now ${peekMessages(ws).length}`);
  appendAgentAssumptions(tasksPath, drained.map(m => m.text));
  console.log('tasks.md after appendAgentAssumptions:');
  console.log(fs.readFileSync(tasksPath, 'utf8'));
  console.log(`resume feedback:\n${buildResumeFeedback(ws, drained)}`);

  console.log('\n-- 5. questions roundtrip --');
  recordAgentQuestions(tasksPath, ['Is the parser recursive?', 'Which test file?']);
  let q = readAgentQuestions(fs.readFileSync(tasksPath, 'utf8'));
  console.log(`pending=${q.pending.length} answered=${q.answered.length}`);
  let content = fs.readFileSync(tasksPath, 'utf8').replace('Q1: Is the parser recursive?', 'Q1: Is the parser recursive?\nA1: yes');
  fs.writeFileSync(tasksPath, content, 'utf8');
  q = readAgentQuestions(fs.readFileSync(tasksPath, 'utf8'));
  console.log(`after A1: pending=${q.pending.length} answered=${JSON.stringify(q.answered)}`);
  removeConsumedQuestions(tasksPath);
  const after = fs.readFileSync(tasksPath, 'utf8');
  console.log(`after consume: questions heading gone=${!after.includes(QUESTIONS_HEADING)}, assumptions kept=${after.includes(ASSUMPTIONS_HEADING)}`);

  fs.rmSync(ws, { recursive: true, force: true });
  console.log('\n=== done ===');
}

main().catch(err => { console.error(err); process.exit(1); });
