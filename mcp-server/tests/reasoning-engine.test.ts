import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

describe('Working Reasoning Model GGUF Forward Pass', () => {
  const scriptPath = path.resolve(__dirname, '../scripts/reasoning_engine.py');
  const fixturePath = path.resolve(__dirname, 'fixtures/models/reasoning_tiny.gguf');
  const pythonBin = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

  beforeAll(() => {
    if (!fs.existsSync(fixturePath)) {
      const genScript = path.resolve(__dirname, '../scripts/utils/generate_model_fixtures.py');
      execFileSync(pythonBin, [genScript], { timeout: 30000, encoding: 'utf8' });
    }
  });

  it('runs forward pass on GGUF reasoning model and emits thinking trace', () => {
    const raw = execFileSync(pythonBin, [
      scriptPath,
      'generate',
      '--file', fixturePath,
      '--prompt', 'Solve: 2 + 3 * 4',
      '--max-tokens', '8',
      '--temperature', '0.0'
    ], { timeout: 15000, encoding: 'utf8' });

    const result = JSON.parse(raw);
    expect(result.tokensGenerated.length).toBeGreaterThan(0);
    expect(result.output).not.toBe('<pad>');
    expect(result.output).not.toBe('</think>');
    expect(result.reasoningTrace).toContain('<think>');
    expect(result.reasoningTrace).toContain('</think>');
    expect(result.output).toBe('14');
  });

  it('emits varied outputs when temperature is non-zero', () => {
    const run1 = JSON.parse(execFileSync(pythonBin, [
      scriptPath,
      'generate',
      '--file', fixturePath,
      '--prompt', 'Reflect on logic',
      '--max-tokens', '8',
      '--temperature', '0.8',
      '--seed', '101'
    ], { timeout: 15000, encoding: 'utf8' }));

    const run2 = JSON.parse(execFileSync(pythonBin, [
      scriptPath,
      'generate',
      '--file', fixturePath,
      '--prompt', 'Reflect on logic',
      '--max-tokens', '8',
      '--temperature', '0.8',
      '--seed', '202'
    ], { timeout: 15000, encoding: 'utf8' }));

    expect(run1.tokensGenerated).not.toEqual(run2.tokensGenerated);
  });
});
