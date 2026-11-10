import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

describe('Mixture-of-Experts Engine and Assembly', () => {
  const scriptPath = path.resolve(__dirname, '../scripts/moe_engine.py');
  const pythonBin = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

  it('routes tokens across experts with top-k gating and computes aux_loss', () => {
    const raw = execFileSync(pythonBin, [
      scriptPath,
      'test_moe',
      '--num-experts', '4',
      '--top-k', '2',
      '--dim', '8',
      '--seq-len', '4'
    ], { timeout: 15000, encoding: 'utf8' });

    const result = JSON.parse(raw);
    expect(result.numExperts).toBe(4);
    expect(result.topK).toBe(2);
    expect(result.routingProbabilities.length).toBe(8);
    expect(result.auxLoss).toBeGreaterThanOrEqual(0);
    expect(result.groupedExecutionEqual).toBe(true);
  });

  it('fails when top_k exceeds num_experts', () => {
    expect(() => {
      execFileSync(pythonBin, [
        scriptPath,
        'test_moe',
        '--num-experts', '2',
        '--top-k', '5',
      ], { timeout: 15000, stdio: 'pipe' });
    }).toThrow();
  });

  it('assembles composite MoE structure with ScaledSwiGLU metadata', () => {
    const raw = execFileSync(pythonBin, [
      scriptPath,
      'assemble',
      '--num-experts', '4'
    ], { timeout: 15000, encoding: 'utf8' });

    const result = JSON.parse(raw);
    expect(result.architecture).toBe('MixtureOfExperts');
    expect(result.numExperts).toBe(4);
    expect(result.experts).toHaveLength(4);
    expect(result.fusionScheme).toBe('ScaledSwiGLU');
  });
});
