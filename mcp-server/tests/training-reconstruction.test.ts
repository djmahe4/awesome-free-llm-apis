import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

describe('Training Data Reconstruction & Memorization Probing', () => {
  const scriptPath = path.resolve(__dirname, '../scripts/model_inspector.py');
  const ptFixture = path.resolve(__dirname, 'fixtures/models/tiny.pt');
  const tempOut = path.join(os.tmpdir(), `reconstructed_sample_${Date.now()}.json`);

  it('synthesizes class exemplar prototype and scores memorization risk', () => {
    try {
      const rawOut = execFileSync('python', [
        scriptPath,
        'reconstruct_samples',
        '--file', ptFixture,
        '--format', 'pytorch',
        '--target-class', '0',
        '--steps', '10',
        '--output', tempOut
      ], { encoding: 'utf8' });

      const result = JSON.parse(rawOut);
      expect(result.targetClass).toBe(0);
      expect(result.className).toBe('ball');
      expect(result.synthesizedExemplar).toBeDefined();
      expect(result.synthesizedExemplar.dimensions).toEqual([1, 4]);
      expect(result.memorizationRiskScore).toBeGreaterThanOrEqual(0);
      expect(result.epistemicDisclaimer).toContain('representative prototype');
      expect(fs.existsSync(tempOut)).toBe(true);
    } finally {
      if (fs.existsSync(tempOut)) {
        fs.unlinkSync(tempOut);
      }
    }
  });
});
