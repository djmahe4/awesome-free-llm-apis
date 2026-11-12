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
