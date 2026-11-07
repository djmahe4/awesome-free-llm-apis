import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

describe('Model Layer Extractor & Profiler', () => {
  const scriptPath = path.resolve(__dirname, '../scripts/model_inspector.py');
  const ggufFixture = path.resolve(__dirname, 'fixtures/models/tiny.gguf');
  const tempSafeTensors = path.resolve(__dirname, 'fixtures/models/extracted_blk0.safetensors');

  it('slices a layer into a standalone .safetensors file and profiles statistics', () => {
    try {
      // 1. Extract layer
      execFileSync('python', [
        scriptPath,
        'extract_layer',
        '--file', ggufFixture,
        '--layer', 'blk.0.attn_q.weight',
        '--output', tempSafeTensors
      ], { encoding: 'utf8' });
      expect(fs.existsSync(tempSafeTensors)).toBe(true);

      // 2. Analyze layer statistics
      const rawOut = execFileSync('python', [
        scriptPath,
        'analyze_layer',
        '--file', ggufFixture,
        '--layer', 'blk.0.attn_q.weight'
      ], { encoding: 'utf8' });

      const stats = JSON.parse(rawOut);
      expect(stats.layerName).toBe('blk.0.attn_q.weight');
      expect(stats.shape).toEqual([4, 4]);
      expect(stats.elementCount).toBe(16);
      expect(stats.frobeniusNorm).toBeGreaterThan(0);
      expect(stats.mean).toBeDefined();
    } finally {
      if (fs.existsSync(tempSafeTensors)) {
        fs.unlinkSync(tempSafeTensors);
      }
    }
  });
});
