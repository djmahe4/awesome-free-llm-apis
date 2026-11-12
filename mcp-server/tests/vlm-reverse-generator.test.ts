import { describe, it, expect } from 'vitest';
import { handleReverseTool } from '../src/tools/reverse-tool.js';

describe('VLM Reverse Image Synthesis & Attribution Engine', () => {
  it('generates synthetic image from text prompt via reverse feature projection', async () => {
    const res = await handleReverseTool({
      action: 'reverse_vlm_generate',
      target: 'synthetic_vlm_engine',
      authorization: 'lab',
      options: {
        prompt: 'soccer player striking ball into top corner goal',
        mode: 'feature_attribution',
        resolution: 256,
        seed: 42,
      },
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.output_path).toBeDefined();
    expect(typeof data.output_path).toBe('string');
    expect(data.output_path.endsWith('.png')).toBe(true);
    expect(data.tokens).toContain('soccer');
    expect(data.token_attributions).toBeDefined();
    expect(data.spatial_patches).toBeDefined();
    expect(Array.isArray(data.latent_energy_map)).toBe(true);
    expect(data.learning_notes).toContain('Vision-Language');
  });

  it('produces class activation prototype map for semantic concepts', async () => {
    const res = await handleReverseTool({
      action: 'reverse_vlm_generate',
      target: 'synthetic_vlm_engine',
      authorization: 'lab',
      options: {
        prompt: 'referee blowing whistle pitch boundary',
        mode: 'prototype_activation',
        resolution: 128,
      },
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.output_path).toBeDefined();
    expect(data.metrics.peak_saliency).toBeGreaterThan(0);
  });
});
