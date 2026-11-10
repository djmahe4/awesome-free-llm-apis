import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { handleReverseTool, runReverseTool } from '../src/tools/reverse-tool.js';

describe('torch_nn_engine Architecture Generalization & Forward Passes', () => {
  const modelsDir = path.resolve(__dirname, 'fixtures/models');
  const tinyPt = path.join(modelsDir, 'tiny.pt');
  const tinyResNetPt = path.join(modelsDir, 'tiny_resnet.pt');
  const tinyMobileNetPt = path.join(modelsDir, 'tiny_mobilenet.pt');
  const tinyYoloOnnx = path.join(modelsDir, 'tiny_yolo.onnx');
  const footydjBestPt = 'C:\\Users\\mahes\\OneDrive\\Desktop\\Python-Projects\\footydj_local_app\\runs\\pose\\train\\weights\\best.pt';

  it('runs YOLO detection forward pass on tiny.pt with DFL decode and NMS', async () => {
    const res = await handleReverseTool({
      action: 'run_torch_nn',
      target: tinyPt,
      authorization: 'lab',
      options: { task: 'detect' },
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.modelType).toContain('YOLO');
    expect(data.task).toBe('detect');
    expect(data.fusedLayersCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(data.detections)).toBe(true);
    expect(data.detections.length).toBeGreaterThan(0);
    const firstDet = data.detections[0];
    expect(firstDet.box).toHaveLength(4);
    expect(firstDet.confidence).toBeGreaterThan(0);
    expect(firstDet.className).toBeDefined();
    expect(Array.isArray(data.layerActivations)).toBe(true);
    expect(data.layerActivations.length).toBeGreaterThanOrEqual(4);
  });

  it('runs ResNet classification forward pass on tiny_resnet.pt (residual blocks + fc)', async () => {
    const res = await handleReverseTool({
      action: 'run_torch_nn',
      target: tinyResNetPt,
      authorization: 'lab',
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.modelType).toBe('ResNet');
    expect(data.task).toBe('classify');
    expect(data.fusedLayersCount).toBeGreaterThanOrEqual(1);
    expect(data.topClass).toBeDefined();
    expect(data.topProbability).toBeGreaterThan(0);
    expect(Array.isArray(data.predictions)).toBe(true);
    expect(data.predictions.length).toBeGreaterThan(0);
    expect(Array.isArray(data.layerActivations)).toBe(true);
    expect(data.layerActivations.length).toBeGreaterThanOrEqual(5);
  });

  it('runs MobileNet classification forward pass on tiny_mobilenet.pt (inverted residual + depthwise separable)', async () => {
    const res = await handleReverseTool({
      action: 'run_torch_nn',
      target: tinyMobileNetPt,
      authorization: 'lab',
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.modelType).toBe('MobileNet');
    expect(data.task).toBe('classify');
    expect(data.fusedLayersCount).toBeGreaterThanOrEqual(1);
    expect(data.topClass).toBeDefined();
    expect(data.topProbability).toBeGreaterThan(0);
    expect(Array.isArray(data.predictions)).toBe(true);
    expect(Array.isArray(data.layerActivations)).toBe(true);
    expect(data.layerActivations.length).toBeGreaterThanOrEqual(5);
  });

  it('auto-identifies YOLO from ONNX format (tiny_yolo.onnx) without hardcoding', async () => {
    const res = await handleReverseTool({
      action: 'run_torch_nn',
      target: tinyYoloOnnx,
      authorization: 'lab',
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.modelType).toContain('YOLO');
    expect(data.task).toBe('detect');
    expect(Array.isArray(data.detections)).toBe(true);
    expect(data.detections.length).toBeGreaterThan(0);
  });

  it('adapts YOLO forward pass across modular tasks (classify vs segment vs pose)', async () => {
    // Classification
    const resCls = await handleReverseTool({
      action: 'run_torch_nn',
      target: tinyPt,
      authorization: 'lab',
      options: { task: 'classify' },
    });
    expect(resCls.success).toBe(true);
    expect((resCls.data as any).task).toBe('classify');
    expect((resCls.data as any).predictions).toBeDefined();

    // Segmentation
    const resSeg = await handleReverseTool({
      action: 'run_torch_nn',
      target: tinyPt,
      authorization: 'lab',
      options: { task: 'segment' },
    });
    expect(resSeg.success).toBe(true);
    expect((resSeg.data as any).task).toBe('segment');
    expect((resSeg.data as any).segments).toBeDefined();
    expect((resSeg.data as any).maskPrototypesCount).toBe(16);

    // Pose
    const resPose = await handleReverseTool({
      action: 'run_torch_nn',
      target: tinyPt,
      authorization: 'lab',
      options: { task: 'pose' },
    });
    expect(resPose.success).toBe(true);
    expect((resPose.data as any).task).toBe('pose');
    expect((resPose.data as any).poses).toBeDefined();
    expect((resPose.data as any).poses[0].keypoints).toBeDefined();
  }, 20000);

  it('verifies Conv2d and BatchNorm folding numerical equivalence via python script', async () => {
    const pythonScript = path.resolve(__dirname, '../scripts/torch_nn_engine.py');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const scriptsDir = path.resolve(__dirname, '../scripts').replace(/\\/g, '/');
    const testCode = `
import sys
sys.path.insert(0, "${scriptsDir}")
import numpy as np
from torch_nn_engine import conv2d, fuse_conv_bn

np.random.seed(123)
x = np.random.randn(2, 4, 8, 8).astype(np.float32)
w = np.random.randn(6, 4, 3, 3).astype(np.float32)
b = np.random.randn(6).astype(np.float32)
rm = np.random.randn(6).astype(np.float32)
rv = np.abs(np.random.randn(6).astype(np.float32)) + 0.1
gamma = np.random.randn(6).astype(np.float32)
beta = np.random.randn(6).astype(np.float32)

conv_out = conv2d(x, w, b, stride=1, padding=1)
inv_std = gamma / np.sqrt(rv + 1e-5)
bn_out = (conv_out - rm[None, :, None, None]) * inv_std[None, :, None, None] + beta[None, :, None, None]

fused_w, fused_b = fuse_conv_bn(w, b, rm, rv, gamma, beta, eps=1e-5)
fused_out = conv2d(x, fused_w, fused_b, stride=1, padding=1)

diff = np.max(np.abs(bn_out - fused_out))
assert diff < 1e-4, f"BN folding diff too large: {diff}"
print(f"SUCCESS: diff={diff:.6e}")
`;

    const { stdout } = await execFileAsync('python', ['-c', testCode]);
    expect(stdout).toContain('SUCCESS:');
  });

  it('smoke tests real footydj pose model artifact (best.pt) if present', async () => {
    if (!fs.existsSync(footydjBestPt)) {
      return;
    }

    const res = await handleReverseTool({
      action: 'run_yolo_nn',
      target: footydjBestPt,
      authorization: 'lab',
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.modelType).toContain('YOLO');
    expect(data.task).toBe('pose');
    expect(Array.isArray(data.detections)).toBe(true);
    expect(Array.isArray(data.poses)).toBe(true);
    expect(data.poses.length).toBeGreaterThan(0);
    expect(data.poses[0].keypoints).toHaveLength(30);
  });

  it('runs YOLO forward pass with real match frame and letterbox metadata', async () => {
    const framePath = path.resolve(__dirname, 'fixtures/media/frames/frame_0050.jpg');
    if (!fs.existsSync(footydjBestPt) || !fs.existsSync(framePath)) {
      return;
    }

    const res = await handleReverseTool({
      action: 'run_torch_nn',
      target: footydjBestPt,
      authorization: 'lab',
      sessionId: 'smoke-test-real-frame-' + Date.now(),
      options: { image: framePath },
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.inputMetadata.source).toBe('image_file');
    expect(data.inputMetadata.letterbox).toBeDefined();
    expect(data.inputMetadata.letterbox.originalSize).toEqual([1920, 1080]);
    expect(data.weight_source).toBe('checkpoint_state_dict');
    expect(data.real_tensors_used.length).toBeGreaterThan(0);
  });

  it('runs forward pass on without_image bias manifold canvas', async () => {
    const res = await handleReverseTool({
      action: 'run_torch_nn',
      target: tinyPt,
      authorization: 'lab',
      options: { image: 'without_image' },
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.inputMetadata.source).toBe('without_image_bias_manifold');
    expect(Array.isArray(data.layerActivations)).toBe(true);
  });
});
