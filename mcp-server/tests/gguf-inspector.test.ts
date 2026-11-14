import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

describe('GGUF Model Inspector', () => {
  const scriptPath = path.resolve(__dirname, '../scripts/model_inspector.py');
  const ggufFixture = path.resolve(__dirname, 'fixtures/models/tiny.gguf');

  it('inspects GGUF metadata and tensor tables with zero copy', () => {
    const rawOut = execFileSync('python', [
      scriptPath,
      'inspect',
      '--file', ggufFixture,
      '--format', 'gguf'
    ], { encoding: 'utf8' });

    const result = JSON.parse(rawOut);
    expect(result.format).toBe('gguf');
    expect(result.version).toBe(3);
    expect(result.architecture).toBe('tiny_transformer');
    expect(result.contextLength).toBe(512);
    expect(result.tensorCount).toBe(2);
    expect(result.tensors[0].name).toBe('blk.0.attn_q.weight');
    expect(result.tensors[0].shape).toEqual([4, 4]);
    expect(result.tensors[0].type).toBe('F32');
  });
});
