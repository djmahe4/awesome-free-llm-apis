import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { handleReverseTool } from '../src/tools/reverse-tool.js';

describe('Reverse Tool - Object-Aware 3D Augmentation & 2.5D Parallax Engine', () => {
  const framesDir = path.resolve(__dirname, 'fixtures/media/frames');
  const frame0001 = path.join(framesDir, 'frame_0001.jpg');
  const frame0050 = path.join(framesDir, 'frame_0050.jpg');
  const outDir = path.resolve(__dirname, 'tmp', 'depth-parallax-integration');

  beforeAll(() => {
    fs.mkdirSync(outDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('returns not_available when local Depth Anything weights are absent in default model mode', async () => {
    const prev = process.env.DEPTH_ANYTHING_MODEL_PATH;
    process.env.DEPTH_ANYTHING_MODEL_PATH = '';
    try {
      const res = await handleReverseTool({
        action: 'run_depth_parallax',
        target: frame0050,
        authorization: 'lab',
      });
      expect(res.success).toBe(true);
      const data = res.data as any;
      expect(data.ok).toBe(false);
      expect(data.status).toBe('not_available');
      expect(data.error).toContain('no weights were downloaded');
    } finally {
      if (prev === undefined) delete process.env.DEPTH_ANYTHING_MODEL_PATH;
      else process.env.DEPTH_ANYTHING_MODEL_PATH = prev;
    }
  }, 30000);

  it('runs continuous_parallax with projective camera homography in explicit heuristic mode', async () => {
    const outImg = path.join(outDir, 'test_scene_parallax.png');
    const res = await handleReverseTool({
      action: 'run_depth_parallax',
      target: frame0050,
      authorization: 'lab',
      options: {
        mode: 'continuous_parallax',
        depthMode: 'heuristic',
        yaw: 4.0,
        pitch: 2.0,
        dolly: 12.0,
        pan: 5.0,
        output: outImg,
      },
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.ok).toBe(true);
    expect(data.operation).toBe('pseudo_3d_parallax');
    expect(data.depth_backend).toBe('heuristic');
    expect(data.output_base64).toBeDefined();
    expect(data.metrics.homography_applied).toBe(true);
    expect(data.metrics.projection_model).toBe('perspective_3d_homography');
    expect(data.metrics.depth_entropy_bits).toBeGreaterThan(0);
    expect(data.metrics.out_of_frame_ratio).toBeLessThan(0.05);
    expect(data.metrics.disocclusion_ratio).toBeNull();
    expect(fs.existsSync(outImg)).toBe(true);
  }, 30000);

  it('rotates explicit full referee bbox [470,35,1060,1075] with GrabCut without head slicing', async () => {
    const outImg = path.join(outDir, 'test_referee_fullbody_3d.png');
    const res = await handleReverseTool({
      action: 'run_depth_parallax',
      target: frame0050,
      authorization: 'lab',
      options: {
        mode: 'object_3d_rotation',
        depthMode: 'heuristic',
        bbox: [470, 35, 1060, 1075],
        maskType: 'grabcut',
        yaw: 18.0,
        pitch: 6.0,
        roll: -4.0,
        output: outImg,
      },
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.ok).toBe(true);
    expect(data.operation).toBe('pseudo_3d_object_transform');
    expect(data.metrics.depth_source).toBe('heuristic');
    expect(data.metrics.homography_applied).toBe(true);
    expect(data.metrics.target_bbox).toEqual([470, 35, 1060, 1075]);
    expect(data.metrics.mask_backend).toBe('opencv_grabcut');
    expect(data.metrics.object_pixels_transformed).toBeGreaterThan(150000);
    expect(data.metrics.foreground_retention_ratio).toBeGreaterThan(0.85);
    expect(data.metrics.background_stability_score).toBeGreaterThan(0.97);
    expect(fs.existsSync(outImg)).toBe(true);
  }, 45000);

  it('rotates isolated ball bbox [680,440,860,640] on frame_0050', async () => {
    const outImg = path.join(outDir, 'test_ball_bbox_3d.png');
    const res = await handleReverseTool({
      action: 'run_depth_parallax',
      target: frame0050,
      authorization: 'lab',
      options: {
        mode: 'object_3d_rotation',
        depthMode: 'heuristic',
        bbox: [680, 440, 860, 640],
        maskType: 'sphere',
        yaw: 30.0,
        pitch: 10.0,
        output: outImg,
      },
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.ok).toBe(true);
    expect(data.metrics.target_bbox).toEqual([680, 440, 860, 640]);
    expect(data.metrics.object_pixels_transformed).toBeGreaterThan(5000);
    expect(data.metrics.background_stability_score).toBeGreaterThan(0.99);
    expect(fs.existsSync(outImg)).toBe(true);
  }, 30000);

  it('runs animate_still generating multi-frame orbital pseudo-3D sequence GIF', async () => {
    const outGif = path.join(outDir, 'test_animate_still_orbit.gif');
    const res = await handleReverseTool({
      action: 'animate_still',
      target: frame0050,
      authorization: 'lab',
      options: {
        depthMode: 'heuristic',
        frames: 4,
        fps: 6,
        trajectory: 'orbit',
        azimuthAmp: 4.0,
        elevationAmp: 1.5,
        output: outGif,
      },
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.ok).toBe(true);
    expect(data.operation).toBe('animate_still');
    expect(data.frames_count).toBe(4);
    expect(data.fps).toBe(6);
    expect(data.output_base64).toBeDefined();
    expect(data.metrics.file_size_bytes).toBeGreaterThan(1000);
    expect(fs.existsSync(outGif)).toBe(true);
  }, 45000);

  it('runs animate_still object_spin on frame_0001 explicit referee bbox without angle overflow', async () => {
    const outGif = path.join(outDir, 'test_animate_still_referee_spin.gif');
    const res = await handleReverseTool({
      action: 'animate_still',
      target: frame0001,
      authorization: 'lab',
      options: {
        mode: 'object_3d_rotation',
        depthMode: 'heuristic',
        bbox: [620, 20, 1220, 1080],
        maskType: 'grabcut',
        frames: 4,
        fps: 4,
        trajectory: 'object_spin',
        azimuthAmp: 5.0,
        output: outGif,
      },
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.ok).toBe(true);
    expect(data.operation).toBe('animate_still');
    expect(data.frames_count).toBe(4);
    expect(data.output_base64).toBeDefined();
    expect(fs.existsSync(outGif)).toBe(true);
  }, 60000);

  it('handles invalid file and path traversal securely', async () => {
    const res = await handleReverseTool({
      action: 'run_depth_parallax',
      target: path.join(framesDir, 'non_existent_frame.jpg'),
      authorization: 'lab',
    });
    expect(res.success).toBe(false);
    expect(res.error).toBeDefined();
  });

  it('fails with clear error directly in tool call when optional dependency is missing', async () => {
    const res = await handleReverseTool({
      action: 'run_depth_parallax',
      target: frame0050,
      authorization: 'lab',
      options: {
        _mockDeps: { pil: false, cv2: false, torch: false },
      },
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Optional Python dependency "Pillow" (PIL) is not installed');
  });
});
