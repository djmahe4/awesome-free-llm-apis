import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

describe('YOLOv8 Pure Neural Network Reconstruction', () => {
  const scriptPath = path.resolve(__dirname, '../scripts/yolo_nn_engine.py');
  const ptFixture = path.resolve(__dirname, 'fixtures/models/tiny.pt');
  const pythonBin = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

  beforeAll(() => {
    if (!fs.existsSync(ptFixture)) {
      const genScript = path.resolve(__dirname, '../scripts/utils/generate_model_fixtures.py');
      execFileSync(pythonBin, [genScript], { timeout: 30000, encoding: 'utf8' });
    }
  });

  it('folds BatchNorm into Conv2d and executes spatial forward pass from scratch', () => {
    const raw = execFileSync(pythonBin, [
      scriptPath,
      'detect',
      '--file', ptFixture,
      '--channels', '3',
      '--size', '32'
    ], { timeout: 15000, encoding: 'utf8' });

    const result = JSON.parse(raw);
    expect(result.modelType).toBe('YOLOv8');
    expect(result.fusedLayersCount).toBeGreaterThan(0);
    expect(result.detections).toBeInstanceOf(Array);
    expect(result.detections.length).toBeGreaterThan(0);
    expect(result.detections[0].box.length).toBe(4); // [x1, y1, x2, y2]
    expect(result.detections[0].confidence).toBeGreaterThan(0);
    expect(result.detections[0].className).toBeDefined();
  });

  it('verifies fuse_conv_bn mathematical equivalence with separate Conv and BN', () => {
    const pyCode = [
      'import sys, os, json',
      `sys.path.insert(0, os.path.dirname(r"""${scriptPath}"""))`,
      'import numpy as np',
      'from yolo_nn_engine import conv2d, fuse_conv_bn',
      'np.random.seed(42)',
      'x = np.random.randn(2, 3, 8, 8).astype(np.float32)',
      'w = np.random.randn(4, 3, 3, 3).astype(np.float32)',
      'b = np.random.randn(4).astype(np.float32)',
      'rm = np.random.randn(4).astype(np.float32)',
      'rv = np.abs(np.random.randn(4).astype(np.float32)) + 0.1',
      'gamma = np.random.randn(4).astype(np.float32)',
      'beta = np.random.randn(4).astype(np.float32)',
      'conv_out = conv2d(x, w, b, stride=1, padding=1)',
      'eps = 1e-5',
      'bn_out = gamma[None, :, None, None] * (conv_out - rm[None, :, None, None]) / np.sqrt(rv[None, :, None, None] + eps) + beta[None, :, None, None]',
      'fused_w, fused_b = fuse_conv_bn(w, b, rm, rv, gamma, beta, eps=eps)',
      'fused_out = conv2d(x, fused_w, fused_b, stride=1, padding=1)',
      'max_diff = float(np.max(np.abs(bn_out - fused_out)))',
      'print(json.dumps({"maxDiff": max_diff, "isClose": bool(np.allclose(bn_out, fused_out, atol=1e-5))}))'
    ].join('\n');

    const raw = execFileSync(pythonBin, ['-c', pyCode], { timeout: 15000, encoding: 'utf8' });
    const res = JSON.parse(raw);
    expect(res.isClose).toBe(true);
    expect(res.maxDiff).toBeLessThan(1e-4);
  });

  it('throws FileNotFoundError and exits with non-zero code for missing checkpoint', () => {
    const nonExistent = path.resolve(__dirname, 'fixtures/models/non_existent.pt');
    expect(() => {
      execFileSync(pythonBin, [
        scriptPath,
        'detect',
        '--file', nonExistent,
        '--channels', '3',
        '--size', '32'
      ], { timeout: 15000, encoding: 'utf8', stdio: 'pipe' });
    }).toThrow();

    try {
      execFileSync(pythonBin, [
        scriptPath,
        'detect',
        '--file', nonExistent,
        '--channels', '3',
        '--size', '32'
      ], { timeout: 15000, encoding: 'utf8', stdio: 'pipe' });
    } catch (err: any) {
      expect(err.status).not.toBe(0);
      const stderr = err.stderr ? err.stderr.toString() : '';
      expect(stderr).toContain('FileNotFoundError');
    }
  });
});
