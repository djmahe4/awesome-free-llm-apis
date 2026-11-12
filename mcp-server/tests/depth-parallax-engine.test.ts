import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { removeDir } from './helpers/temp-dir.js';

const pythonBin = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const scriptPath = path.resolve(__dirname, '../scripts/depth_parallax_engine.py');
let tmpDir: string;
let fixtureImg: string;
let outImg: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depth-parallax-test-'));
  fixtureImg = path.join(tmpDir, 'fixture.png');
  outImg = path.join(tmpDir, 'output.png');
  const makeFixturePy = [
    'from PIL import Image',
    'import numpy as np',
    'arr = np.zeros((64, 64, 3), dtype=np.uint8)',
    'arr[8:56, 8:56] = [50, 100, 150]',
    'arr[20:44, 20:44] = [220, 80, 40]',
    `Image.fromarray(arr).save(r"""${fixtureImg}""")`,
  ].join('\n');
  execFileSync(pythonBin, ['-c', makeFixturePy], { timeout: 15000, encoding: 'utf8' });
});

afterAll(async () => {
  if (tmpDir) await removeDir(tmpDir);
});

describe('Depth-guided pseudo-3D engine', () => {
  it('honestly reports unavailable when local Depth Anything weights are absent', () => {
    const raw = execFileSync(pythonBin, [scriptPath, '--file', fixtureImg, '--output', outImg], {
      timeout: 20000,
      encoding: 'utf8',
      env: { ...process.env, DEPTH_ANYTHING_MODEL_PATH: '' },
    });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('not_available');
    expect(result.error).toContain('no weights were downloaded');
    expect(fs.existsSync(outImg)).toBe(false);
  });

  it('uses explicitly selected heuristic depth and persists inspectable image artifact', () => {
    const raw = execFileSync(pythonBin, [
      scriptPath, '--file', fixtureImg, '--depth-mode', 'heuristic', '--depth-layers', '8',
      '--dolly', '15', '--pan', '2', '--output', outImg,
    ], { timeout: 20000, encoding: 'utf8' });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.operation).toBe('pseudo_3d_parallax');
    expect(result.depth_backend).toBe('heuristic');
    expect(result.output_path).toBe(outImg);
    expect(result.output_base64.length).toBeGreaterThan(50);
    expect(fs.statSync(outImg).size).toBeGreaterThan(100);
    expect(result.metrics.depth_entropy_bits).toBeGreaterThan(0);
    expect(result.metrics.mean_flow_pixels).toBeGreaterThan(0);
    expect(result.metrics.disocclusion_ratio).toBeNull();
    expect(result.metrics.disocclusion_status).toContain('not_measured');
  });

  it('rotates only an explicitly selected bbox and labels hidden-surface limits', () => {
    const raw = execFileSync(pythonBin, [
      scriptPath, '--file', fixtureImg, '--depth-mode', 'heuristic',
      '--mode', 'object_3d_rotation', '--mask-type', 'rect', '--bbox', '12,12,52,52',
      '--yaw', '10', '--output', outImg,
    ], { timeout: 20000, encoding: 'utf8' });
    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.operation).toBe('pseudo_3d_object_transform');
    expect(result.metrics.mode).toBe('pseudo_3d_object_rotation');
    expect(result.metrics.target_bbox).toEqual([12, 12, 52, 52]);
    expect(result.metrics.foreground_retention_ratio).toBeGreaterThan(0);
    expect(result.metrics.disocclusion_ratio).toBeNull();
    expect(result.render_type).toContain('hidden surfaces are not reconstructed');
  });

  it('rejects object rotation without an explicit bbox', () => {
    expect(() => execFileSync(pythonBin, [
      scriptPath, '--file', fixtureImg, '--depth-mode', 'heuristic', '--mode', 'object_3d_rotation',
    ], { timeout: 15000, encoding: 'utf8' })).toThrow();
  });
});
