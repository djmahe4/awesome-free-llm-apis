import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildZedThoughtDag, expandZedThoughtDag, listZedSessions, openZedDb, readZedThoughtDags, scanZedThreadSchema } from '../src/harness/zed-reader.js';
import { removeDir } from './helpers/temp-dir.js';
import { expandAgentThoughtContext } from '../src/harness/agent-thought-context.js';

const tempDirs: string[] = [];
afterAll(async () => {
  for (const dir of tempDirs) await removeDir(dir);
});

function makeDb(): { dbPath: string; workspace: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zed-reader-'));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'threads.db');
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace);
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE threads (id TEXT, summary TEXT, updated_at TEXT, data_type TEXT, data BLOB, folder_paths TEXT)');
  const data = JSON.stringify({ messages: [
    { User: { id: 'u1', content: [{ Text: 'Implement reader for this workspace' }] } },
    { Agent: { content: [
      { Thinking: { text: 'Inspect local thread schema' } },
      { ToolUse: { id: 'call-1', name: 'Read', raw_input: '{"path":"src/file.ts"}' } },
    ], tool_results: { 'call-1': { tool_use_id: 'call-1', content: [{ Text: 'export function read() {}' }] } } } },
  ] });
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)').run(
    'thread-1', 'Reader task', '2026-11-13T00:00:00Z', 'json', Buffer.from(data), JSON.stringify([workspace]),
  );
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)').run(
    'thread-2', 'Other project', '2026-11-12T00:00:00Z', 'json', Buffer.from(data), JSON.stringify([`${workspace}-other`]),
  );
  db.close();
  return { dbPath, workspace };
}

describe('Zed reader', () => {
  it('uses dir-scanner schema and reads only threads scoped to exact workspace path', () => {
    const { dbPath, workspace } = makeDb();
    const schema = scanZedThreadSchema(dbPath);
    expect(schema?.tables.find(table => table.name === 'threads')?.columns.map(column => column.name)).toContain('folder_paths');

    const db = openZedDb(dbPath)!;
    try {
      expect(listZedSessions(db, workspace).map(session => session.id)).toEqual(['thread-1']);
    } finally {
      db.close();
    }
    expect(readZedThoughtDags(workspace, { dbPath })).toHaveLength(1);
  });

  it('builds expandable conversation DAG with actual text, tool inputs, and results', () => {
    const dag = buildZedThoughtDag('s1', 'Reader task', { messages: [
      { User: { content: [{ Text: 'Implement reader' }] } },
      { Agent: { content: [
        { Thinking: { text: 'Inspect source layout' } },
        { ToolUse: { id: 'tc', name: 'Read', raw_input: 'path=src/reader.ts' } },
      ], tool_results: { tc: { content: [{ Text: 'export function read() {}' }] } } } },
    ] });
    expect(dag.nodes.map(node => node.kind)).toEqual(['root', 'thought', 'tool_call', 'tool_result']);
    expect(dag.nodes[0].text).toContain('Implement reader');
    expect(dag.nodes[2].text).toContain('path=src/reader.ts');
    expect(dag.nodes[3].text).toContain('export function read() {}');
    expect(expandZedThoughtDag(dag, 'reader source layout')).toContain('Inspect source layout');
    const sharedContext = expandAgentThoughtContext([dag], 'reader source layout');
    expect(sharedContext).toContain('[Agent-thought blackboard: 1 workspace-matched sessions]');
    expect(sharedContext).toContain('export function read() {}');
  });
});
