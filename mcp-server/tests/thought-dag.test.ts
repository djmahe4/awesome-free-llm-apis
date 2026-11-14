import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildThoughtDag, traceRoot, chainOf } from '../src/harness/thought-dag.js';
import { removeDir } from './helpers/temp-dir.js';

const tempDirs: string[] = [];
afterAll(async () => {
  for (const dir of tempDirs) await removeDir(dir);
});

function writeSession(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thought-dag-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return file;
}

const sess = 'sess-1';
const ts = (i: number) => `2026-01-01T00:00:0${i}Z`;
const userText = (text: string, i: number) => ({ sessionId: sess, timestamp: ts(i), message: { role: 'user', content: text } });
const userResults = (results: unknown[], i: number) => ({ sessionId: sess, timestamp: ts(i), message: { role: 'user', content: results } });
const assistant = (content: unknown[], i: number) => ({ sessionId: sess, timestamp: ts(i), message: { role: 'assistant', content } });

describe('buildThoughtDag', () => {
  it('builds a lossless DAG with parent linkage, depths, and goal', async () => {
    const file = writeSession([
      userText('Explore the repo', 0),
      assistant([
        { type: 'thinking', thinking: 'Need to list files first' },
        { type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'ls' } },
      ], 1),
      userResults([{ type: 'tool_result', tool_use_id: 'tc-1', content: [{ type: 'text', text: 'file list' }] }], 2),
      assistant([
        { type: 'thinking', thinking: 'Now read the file' },
        { type: 'tool_use', id: 'tc-2', name: 'Read', input: { file_path: 'x.ts' } },
      ], 3),
      userResults([{ type: 'tool_result', tool_use_id: 'tc-2', content: 'contents', is_error: true }], 4),
    ]);

    const dag = await buildThoughtDag(file);
    expect(dag.sessionId).toBe(sess);
    expect(dag.goal).toBe('Explore the repo');
    expect(dag.nodes.map(n => n.kind)).toEqual([
      'root', 'thought', 'tool_call', 'tool_result', 'thought', 'tool_call', 'tool_result',
    ]);

    const [root, thought1, call1, result1, thought2, call2, result2] = dag.nodes;
    expect(root.parent).toBeNull();
    expect(root.depth).toBe(0);
    expect(root.text).toBe('Explore the repo');

    expect(thought1.parent).toBe(root.id);
    expect(thought1.depth).toBe(1);
    expect(thought1.text).toBe('Need to list files first');

    expect(call1.parent).toBe(thought1.id);
    expect(call1.tool).toBe('Bash');
    expect(call1.toolCallId).toBe('tc-1');
    expect(call1.input).toBe('{"command":"ls"}');

    expect(result1.parent).toBe(call1.id);
    expect(result1.toolCallId).toBe('tc-1');
    expect(result1.resultOk).toBe(true);
    expect(result1.text).toBe('file list');

    expect(thought2.parent).toBe(result1.id);
    expect(thought2.depth).toBe(4);

    expect(call2.tool).toBe('Read');
    expect(result2.resultOk).toBe(false);

    expect(traceRoot(dag, thought2.id)?.id).toBe(root.id);
    expect(chainOf(dag, thought2.id).map(n => n.kind)).toEqual([
      'root', 'thought', 'tool_call', 'tool_result', 'thought',
    ]);
  });

  it('truncates long tool inputs at 120 chars and skips empty thinking blocks', async () => {
    const longCmd = 'x'.repeat(200);
    const file = writeSession([
      userText('g', 0),
      assistant([
        { type: 'thinking', thinking: '' },
        { type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: longCmd } },
      ], 1),
    ]);
    const dag = await buildThoughtDag(file);
    const call = dag.nodes.find(n => n.kind === 'tool_call');
    expect(call?.input).toHaveLength(121);
    expect(call?.input?.endsWith('…')).toBe(true);
    expect(dag.nodes.filter(n => n.kind === 'thought')).toHaveLength(0);
  });

  it('links tool_results back through toolCallNodes even after intervening messages', async () => {
    const file = writeSession([
      userText('g', 0),
      assistant([{ type: 'tool_use', id: 'tc-1', name: 'Grep', input: {} }], 1),
      userText('a side question', 2),
      userResults([{ type: 'tool_result', tool_use_id: 'tc-1', content: 'hit' }], 3),
    ]);
    const dag = await buildThoughtDag(file);
    const result = dag.nodes.find(n => n.kind === 'tool_result');
    const call = dag.nodes.find(n => n.kind === 'tool_call');
    expect(result?.parent).toBe(call?.id);
  });

  it('respects maxLines', async () => {
    const file = writeSession([
      userText('g', 0),
      assistant([{ type: 'thinking', thinking: 't1' }], 1),
      assistant([{ type: 'thinking', thinking: 't2' }], 2),
    ]);
    const dag = await buildThoughtDag(file, { maxLines: 2 });
    expect(dag.nodes).toHaveLength(2);
  });

  it('returns an empty sessionId when records carry none', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thought-dag-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'fallback-id.jsonl');
    fs.writeFileSync(file, JSON.stringify({ message: { role: 'user', content: 'hello' } }) + '\n', 'utf8');
    const dag = await buildThoughtDag(file);
    expect(dag.sessionId).toBe('');
  });
});
