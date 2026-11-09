import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { handleReverseTool } from '../src/tools/reverse-tool.js';

describe('Reverse Tool - Object-Aware 3D Augmentation & 2.5D Parallax Engine', () => {
  const framesDir = path.resolve(__dirname, 'fixtures/media/frames');
  const frame0050 = path.join(framesDir, 'frame_0050.jpg');
  const outDir = path.resolve(__dirname, 'tmp');

  beforeAll(() => {
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
  });

  it('runs scene_parallax with layered depth planes, dolly, and pan', async () => {
    const outImg = path.join(outDir, 'test_scene_parallax.png');
    const res = await handleReverseTool({
      action: 'run_depth_parallax',
      target: frame0050,
      authorization: 'lab',
      options: {
        mode: 'scene_parallax',
        dolly: 12.0,
        pan: 5.0,
        output: outImg,
      },
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.ok).toBe(true);
    expect(data.mode).toBe('scene_parallax');
    expect(data.output_base64).toBeDefined();
    expect(data.metrics.depth_entropy).toBeGreaterThan(0);
    expect(data.metrics.disocclusion_ratio).toBeGreaterThanOrEqual(0);
    expect(fs.existsSync(outImg)).toBe(true);
  }, 30000);

  it('runs multi-scoped 3D augmentation Scope 1: isolated Soccer Ball 3D spin', async () => {
    const outImg = path.join(outDir, 'test_scope_ball_3d.png');
    const res = await handleReverseTool({
      action: 'run_depth_parallax',
      target: frame0050,
      authorization: 'lab',
      options: {
        mode: 'object_3d_rotation',
        target: 'ball',
        yaw: 30.0,
        pitch: 10.0,
        output: outImg,
      },
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.ok).toBe(true);
    expect(data.mode).toBe('object_3d_rotation');
    expect(data.metrics.target).toBe('ball');
    expect(data.metrics.mask_type).toBe('circle');
    expect(data.metrics.pooling_pixel_awareness).toBe(true);
    expect(data.metrics.object_pixels_transformed).toBeGreaterThan(1000);
    expect(data.metrics.background_stability_score).toBeGreaterThan(0.99);
    expect(fs.existsSync(outImg)).toBe(true);
  }, 30000);

  it('runs multi-scoped 3D augmentation Scope 2: Copa Del Rey Pedestal 3D tilt', async () => {
    const outImg = path.join(outDir, 'test_scope_pedestal_3d.png');
    const res = await handleReverseTool({
      action: 'run_depth_parallax',
      target: frame0050,
      authorization: 'lab',
      options: {
        mode: 'object_3d_rotation',
        target: 'pedestal',
        yaw: -25.0,
        pitch: 10.0,
        output: outImg,
      },
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.ok).toBe(true);
    expect(data.mode).toBe('object_3d_rotation');
    expect(data.metrics.target).toBe('pedestal');
    expect(data.metrics.pooling_pixel_awareness).toBe(true);
    expect(data.metrics.object_pixels_transformed).toBeGreaterThan(5000);
    expect(data.metrics.background_stability_score).toBeGreaterThan(0.99);
    expect(fs.existsSync(outImg)).toBe(true);
  }, 30000);

  it('runs multi-scoped 3D augmentation Scope 3: Goalkeeper isolated GrabCut rotation', async () => {
    const outImg = path.join(outDir, 'test_scope_goalkeeper_3d.png');
    const res = await handleReverseTool({
      action: 'run_depth_parallax',
      target: frame0050,
      authorization: 'lab',
      options: {
        mode: 'object_3d_rotation',
        target: 'goalkeeper',
        yaw: -15.0,
        output: outImg,
      },
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.ok).toBe(true);
    expect(data.mode).toBe('object_3d_rotation');
    expect(data.metrics.target).toBe('goalkeeper');
    expect(data.metrics.pooling_pixel_awareness).toBe(true);
    expect(data.metrics.object_pixels_transformed).toBeGreaterThan(20000);
    expect(data.metrics.background_stability_score).toBeGreaterThan(0.99);
    expect(fs.existsSync(outImg)).toBe(true);
  }, 30000);

  it('runs multi-scoped 3D augmentation Scope 4: Custom Referee BBox with 3D turn', async () => {
    const outImg = path.join(outDir, 'test_scope_referee_custom_bbox.png');
    const res = await handleReverseTool({
      action: 'run_depth_parallax',
      target: frame0050,
      authorization: 'lab',
      options: {
        mode: 'object_3d_rotation',
        bbox: [540, 50, 960, 750],
        maskType: 'grabcut',
        yaw: 15.0,
        output: outImg,
      },
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.ok).toBe(true);
    expect(data.mode).toBe('object_3d_rotation');
    expect(data.metrics.target_bbox).toEqual([540, 50, 960, 750]);
    expect(data.metrics.pooling_pixel_awareness).toBe(true);
    expect(data.metrics.object_pixels_transformed).toBeGreaterThan(50000);
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
        frames: 6,
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
    expect(data.frames_count).toBe(6);
    expect(data.fps).toBe(6);
    expect(data.duration_sec).toBe(1.0);
    expect(data.output_base64).toBeDefined();
    expect(data.metrics.file_size_bytes).toBeGreaterThan(1000);
    expect(fs.existsSync(outGif)).toBe(true);
  }, 40000);

  it('runs animate_still with target="ball" generating volumetric spherical 3D rotation sequence', async () => {
    const outGif = path.join(outDir, 'test_animate_still_ball.gif');
    const res = await handleReverseTool({
      action: 'animate_still',
      target: frame0050,
      authorization: 'lab',
      options: {
        mode: 'object_3d_rotation',
        target: 'ball',
        frames: 6,
        fps: 6,
        trajectory: 'object_spin',
        output: outGif,
      },
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.ok).toBe(true);
    expect(data.operation).toBe('animate_still');
    expect(data.frames_count).toBe(6);
    expect(data.output_base64).toBeDefined();
    expect(fs.existsSync(outGif)).toBe(true);
  }, 40000);

  it('handles invalid file and path traversal securely', async () => {
    const res = await handleReverseTool({
      action: 'run_depth_parallax',
      target: path.join(framesDir, 'non_existent_frame.jpg'),
      authorization: 'lab',
    });
    expect(res.success).toBe(false);
    expect(res.error).toBeDefined();
  });
});
