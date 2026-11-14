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
