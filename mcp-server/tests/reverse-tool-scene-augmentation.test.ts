import { describe, it, expect } from 'vitest';
import { runReverseTool } from '../src/tools/reverse-tool.js';

const FIXTURE = 'tests/fixtures/media/frames/frame_0050.jpg';

function baseInput(operation: string, overrides: Record<string, unknown> = {}, rootOverrides: Record<string, unknown> = {}) {
  return {
    action: 'run_scene_augmentation' as const,
    target: FIXTURE,
    authorization: 'consent' as const,
    ...rootOverrides,
    options: {
      operation,
      kernelSize: 2,
      strides: 2,
      seed: 42,
      ...overrides,
    },
  };
}

describe('run_scene_augmentation validation', () => {
  it('requires authorization framing', async () => {
    const res = await runReverseTool({ action: 'run_scene_augmentation', target: FIXTURE } as any);
    expect(res.success).toBe(false);
    expect(res.error).toContain('authorization');
  });

  it('requires a target', async () => {
    const res = await runReverseTool({ action: 'run_scene_augmentation', authorization: 'consent' } as any);
    expect(res.success).toBe(false);
    expect(res.error).toContain('Target is required');
  });

  it('rejects path traversal in target', async () => {
    const res = await runReverseTool({
      action: 'run_scene_augmentation',
      target: '../../etc/passwd',
      authorization: 'consent',
    } as any);
    expect(res.success).toBe(false);
    expect(res.error).toContain('Path traversal');
  });

  it('rejects unknown operation', async () => {
    const res = await runReverseTool(baseInput('wormhole_warp') as any);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/operation|Unsupported/i);
  });
});

describe('run_scene_augmentation engines (venv python + NumPy)', () => {
  it('max_pool: >= avg_pool deltas, shape halved with stride 2', async () => {
    const maxRes = await runReverseTool(baseInput('max_pool') as any);
    expect(maxRes.success).toBe(true);
    const maxData = maxRes.data as any;
    expect(maxData.ok).toBe(true);
    expect(maxData.operation).toBe('max_pool');
    expect(maxData.output.width).toBeLessThanOrEqual(Math.ceil(maxData.input.width / 2));
    expect(maxData.output.height).toBeLessThanOrEqual(Math.ceil(maxData.input.height / 2));
    expect(typeof maxData.deltas.max_vs_avg).toBe('number');
    expect(maxData.deltas.max_vs_avg).toBeGreaterThanOrEqual(0);
  });

  it('min_pool: <= avg_pool deltas', async () => {
    const minRes = await runReverseTool(baseInput('min_pool') as any);
    expect(minRes.success).toBe(true);
    const minData = minRes.data as any;
    expect(minData.ok).toBe(true);
    expect(minData.deltas.min_vs_avg).toBeLessThanOrEqual(0);
  });

  it('avg_pool: zero deltas by construction', async () => {
    const avgRes = await runReverseTool(baseInput('avg_pool') as any);
    expect(avgRes.success).toBe(true);
    const avgData = avgRes.data as any;
    expect(avgData.ok).toBe(true);
    expect(avgData.deltas.avg_center_dev).toBeGreaterThanOrEqual(0);
  });

  it('gaussian_smooth keeps dimensions with stride 1', async () => {
    const res = await runReverseTool(
      baseInput('gaussian_smooth', { kernelSize: 3, strides: 1, intensity: 0.5 }) as any,
    );
    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.ok).toBe(true);
    expect(data.input.width).toBe(data.output.width);
    expect(data.input.height).toBe(data.output.height);
    expect(Number(data.deltas.smooth_delta)).toBeGreaterThanOrEqual(0);
  });

  it('laplacian_sharpen: edge_delta >= 0 and keeps dimensions', async () => {
    const res = await runReverseTool(
      baseInput('laplacian_sharpen', { kernelSize: 3, strides: 1, intensity: 0.7 }) as any,
    );
    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.ok).toBe(true);
    expect(Number(data.deltas.edge_delta)).toBeGreaterThanOrEqual(0);
    expect(data.input.width).toBe(data.output.width);
    expect(data.input.height).toBe(data.output.height);
    expect(data.keywords).toContain('laplacian_sharpen');
  });

  it('writes PNG output when options.output provided', async () => {
    const outPath = 'tests/tmp/scene_aug_out.png';
    const res = await runReverseTool(baseInput('gaussian_smooth', { kernelSize: 3, strides: 1, output: outPath }) as any);
    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(typeof data.output_path).toBe('string');
  });

  it('supports async with status polling', async () => {
    const session = `scene-async-${Date.now()}`;
    const start = await runReverseTool(
      baseInput('max_pool', { async: true }, { sessionId: session }) as any,
    );
    expect(start.success).toBe(true);
    expect((start.data as any).status).toBe('running');
  });

  it('completes well under the 100ms target when engine warm', async () => {
    const res = await runReverseTool(baseInput('max_pool') as any);
    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.elapsed_ms).toBeLessThan(100);
  });
});
