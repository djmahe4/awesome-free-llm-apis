import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

describe('Quantization and Dequantization Engine', () => {
  const scriptPath = path.resolve(__dirname, '../scripts/quant_engine.py');
  const pythonBin = process.env.PYTHON || 'python';

  it('quantizes and dequantizes tensors in Q4_0 and Q8_0 with minimal error', () => {
    const rawQ4 = execFileSync(pythonBin, [
      scriptPath,
      'test_quant',
      '--type', 'Q4_0',
      '--elements', '64'
    ], { timeout: 15000, encoding: 'utf8' });

    const resultQ4 = JSON.parse(rawQ4);
    expect(resultQ4.type).toBe('Q4_0');
    expect(resultQ4.blockSize).toBe(32);
    expect(resultQ4.totalBlocks).toBe(2);
    expect(resultQ4.relativeError).toBeLessThan(0.09); // <9% Frobenius relative error
    expect(resultQ4.blocks).toHaveLength(2);
    for (const block of resultQ4.blocks) {
      expect(block.bytes).toHaveLength(16);
    }

    const rawQ8 = execFileSync(pythonBin, [
      scriptPath,
      'test_quant',
      '--type', 'Q8_0',
      '--elements', '64'
    ], { timeout: 15000, encoding: 'utf8' });

    const resultQ8 = JSON.parse(rawQ8);
    expect(resultQ8.type).toBe('Q8_0');
    expect(resultQ8.blockSize).toBe(32);
    expect(resultQ8.totalBlocks).toBe(2);
    expect(resultQ8.relativeError).toBeLessThan(0.01);
    expect(resultQ8.blocks).toHaveLength(2);
    for (const block of resultQ8.blocks) {
      expect(block.bytes).toHaveLength(32);
    }
  });

  it('supports MXFP8 block microscaling across 32-element groups', () => {
    const raw = execFileSync(pythonBin, [
      scriptPath,
      'test_quant',
      '--type', 'MXFP8',
      '--elements', '64'
    ], { timeout: 15000, encoding: 'utf8' });

    const result = JSON.parse(raw);
    expect(result.type).toBe('MXFP8');
    expect(result.scaleBits).toBe(8);
    expect(result.relativeError).toBeLessThan(0.04); // <4% error for MXFP8
  });
});
