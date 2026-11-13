import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ThoughtDatasetWriter } from '../src/harness/thought-dataset-writer.js';
import { removeDir } from './helpers/temp-dir.js';

const tempDirs: string[] = [];
afterAll(async () => {
  for (const dir of tempDirs) await removeDir(dir);
});

describe('ThoughtDatasetWriter', () => {
  it('appends JSONL row with correct schema', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thought-'));
    tempDirs.push(dir);
    const writer = new ThoughtDatasetWriter({ outputDir: dir });
    await writer.append({
      thought: { id: 't1', text: 'load binary header', source: 'rea', timestamp: 0 },
      tool: 'reverse_tool', action: 'analyze_artifact', goal: 'inspect elf',
      alignment: 'aligned', drift_prob: 0.1, expert_label: 'reverse',
    });
    const lines = fs.readFileSync(path.join(dir, 'thoughts.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]);
    expect(row.expert_label).toBe('reverse');
    expect(row.thought_text).toBe('load binary header');
  });

  it('writes DAG linkage fields and expert_source when provided', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thought-link-'));
    tempDirs.push(dir);
    const writer = new ThoughtDatasetWriter({ outputDir: dir });
    await writer.append({
      thought: { id: 'sess:thought:3', text: 'chain thought', source: 'rea', timestamp: 5 },
      tool: 'Read', action: '{"file_path":"x.ts"}', goal: 'g',
      alignment: 'aligned', drift_prob: 0, expert_label: 'coding', expert_source: 'laya',
      parent_thought_id: 'sess:tool_result:2', root_thought_id: 'sess:root:1',
      depth: 4, tool_call_id: 'tc-1', result_ok: true,
    });
    const row = JSON.parse(fs.readFileSync(path.join(dir, 'thoughts.jsonl'), 'utf8').trim());
    expect(row.parent_thought_id).toBe('sess:tool_result:2');
    expect(row.root_thought_id).toBe('sess:root:1');
    expect(row.depth).toBe(4);
    expect(row.tool_call_id).toBe('tc-1');
    expect(row.result_ok).toBe(true);
    expect(row.expert_source).toBe('laya');
  });

  it('defaults linkage fields to null and expert_source to fallback when omitted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thought-default-'));
    tempDirs.push(dir);
    const writer = new ThoughtDatasetWriter({ outputDir: dir });
    await writer.append({
      thought: { id: 't1', text: 'plain', source: 'rea', timestamp: 0 },
      tool: 'none', action: '', goal: 'g',
      alignment: 'aligned', drift_prob: 0, expert_label: 'general',
    });
    const row = JSON.parse(fs.readFileSync(path.join(dir, 'thoughts.jsonl'), 'utf8').trim());
    expect(row.parent_thought_id).toBeNull();
    expect(row.root_thought_id).toBeNull();
    expect(row.depth).toBeNull();
    expect(row.tool_call_id).toBeNull();
    expect(row.result_ok).toBeNull();
    expect(row.expert_source).toBe('fallback');
  });
});

describe('ThoughtDatasetWriter.readRecent', () => {
  it('filters rows by runId prefix, keeps the last K, and tolerates corrupt lines', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thought-replay-'));
    tempDirs.push(dir);
    const writer = new ThoughtDatasetWriter({ outputDir: dir });
    const row = { alignment: 'aligned' as const, drift_prob: 0, goal: 'g' };
    await writer.append({ thought: { id: 'run-a:step1', text: 'first thought', source: 'rea', timestamp: 1 }, tool: 'browser_tool', action: 'navigate', ...row });
    await writer.append({ thought: { id: 'run-b:step1', text: 'other run', source: 'rea', timestamp: 2 }, tool: 'browser_tool', action: 'navigate', ...row });
    await writer.append({ thought: { id: 'run-a:step2', text: 'second thought', source: 'rea', timestamp: 3 }, tool: 'websearch', action: 'search', ...row });
    await writer.append({ thought: { id: 'run-a:step3', text: 'third thought', source: 'rea', timestamp: 4 }, tool: 'manage_memory', action: 'search', ...row });
    await writer.append({ thought: { id: 'run-a:step4', text: 'fourth thought', source: 'rea', timestamp: 5 }, tool: 'browser_tool', action: 'click', ...row });
    fs.appendFileSync(path.join(dir, 'thoughts.jsonl'), '{corrupt json\n', 'utf8');

    const rows = ThoughtDatasetWriter.readRecent(dir, 'run-a', 3);
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.thoughtId)).toEqual(['run-a:step2', 'run-a:step3', 'run-a:step4']);
    expect(rows[0]).toMatchObject({ thoughtText: 'second thought', tool: 'websearch', action: 'search' });
  });

  it('returns [] when the dataset file does not exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thought-empty-'));
    tempDirs.push(dir);
    expect(ThoughtDatasetWriter.readRecent(dir, 'run-a', 3)).toEqual([]);
  });
});
