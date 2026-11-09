import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

describe('2.5D Layered Depth Parallax Engine', () => {
  const scriptPath = path.resolve(__dirname, '../scripts/depth_parallax_engine.py');
  const tmpDir = path.resolve(__dirname, 'tmp');
  const fixtureImg = path.join(tmpDir, 'parallax_sample.png');
  const outImg = path.join(tmpDir, 'parallax_output.png');
  const pythonBin = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

  beforeAll(() => {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    // Generate a minimal test PNG fixture using python PIL
    const makeFixturePy = [
      'from PIL import Image',
      'import numpy as np',
      'arr = np.zeros((64, 64, 3), dtype=np.uint8)',
      'arr[16:48, 16:48] = [255, 100, 50]',
      'arr[32:60, 32:60] = [50, 200, 255]',
      `Image.fromarray(arr).save(r"""${fixtureImg}""")`
    ].join('\n');
    execFileSync(pythonBin, ['-c', makeFixturePy], { timeout: 15000, encoding: 'utf8' });
  });

  it('executes parallax warp CLI and returns valid JSON structure with metrics', () => {
    const raw = execFileSync(pythonBin, [
      scriptPath,
      '--file', fixtureImg,
      '--depth-layers', '8',
      '--dolly', '15',
      '--pan', '0',
      '--near', '20',
      '--far', '100',
      '--output', outImg
    ], { timeout: 20000, encoding: 'utf8' });

    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.operation).toBe('parallax_warp');
    expect(result.layers_count).toBe(8);
    expect(result.dolly_mm).toBe(15);
    expect(typeof result.output_base64).toBe('string');
    expect(result.output_base64.length).toBeGreaterThan(50);
    expect(result.metrics).toBeDefined();
    expect(result.metrics.disocclusion_ratio).toBeGreaterThanOrEqual(0.0);
    expect(result.metrics.disocclusion_ratio).toBeLessThanOrEqual(1.0);
    expect(result.metrics.depth_entropy).toBeGreaterThan(0.0);

    expect(fs.existsSync(outImg)).toBe(true);
  });

  it('fails with non-zero exit code when input file does not exist', () => {
    const nonExistent = path.join(tmpDir, 'non_existent.png');
    expect(() => {
      execFileSync(pythonBin, [
        scriptPath,
        '--file', nonExistent,
        '--depth-layers', '8',
        '--dolly', '15',
        '--pan', '0',
        '--near', '20',
        '--far', '100'
      ], { timeout: 15000, encoding: 'utf8' });
    }).toThrow();
  });
});
