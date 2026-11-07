import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

describe('PyTorch Model Inspector', () => {
  const scriptPath = path.resolve(__dirname, '../scripts/model_inspector.py');
  const ptFixture = path.resolve(__dirname, 'fixtures/models/tiny.pt');

  it('safely inspects PyTorch state_dict and YOLO-style metadata without code execution', () => {
    const rawOut = execFileSync('python', [
      scriptPath,
      'inspect',
      '--file', ptFixture,
      '--format', 'pytorch'
    ], { encoding: 'utf8' });

    const result = JSON.parse(rawOut);
    expect(result.format).toBe('pytorch');
    expect(result.isZipContainer).toBe(true);
    expect(result.metadata.epoch).toBe(14);
    expect(result.metadata.classes).toEqual(['ball', 'player', 'referee']);
    expect(result.records).toBeDefined();
    expect(result.records.some((r: any) => r.name.includes('data.pkl'))).toBe(true);
  });
});
