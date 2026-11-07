import { describe, it, expect } from 'vitest';
import { runReverseTool } from '../src/tools/reverse-tool.js';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

describe('reverse_tool Model Introspection Actions', () => {
  const ggufFixture = path.resolve(__dirname, 'fixtures/models/tiny.gguf');
  const ptFixture = path.resolve(__dirname, 'fixtures/models/tiny.pt');

  it('rejects model actions without authorization framing', async () => {
    const res = await runReverseTool({
      action: 'inspect_model',
      target: ggufFixture,
      options: { format: 'gguf' },
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('authorization framing');
  });

  it('runs inspect_model through runReverseTool() with valid authorization', async () => {
    const res = await runReverseTool({
      action: 'inspect_model',
      target: ggufFixture,
      authorization: 'lab',
      options: { format: 'gguf' },
    });
    expect(res.success).toBe(true);
    expect((res.data as any).format).toBe('gguf');
  });

  it('rejects reconstruct_training_samples without explicit consent authorization', async () => {
    const res = await runReverseTool({
      action: 'reconstruct_training_samples',
      target: ptFixture,
      authorization: 'lab', // Not consent!
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('consent');
  });

  it('runs reconstruct_training_samples with consent authorization', async () => {
    const res = await runReverseTool({
      action: 'reconstruct_training_samples',
      target: ptFixture,
      authorization: 'consent',
      options: { explicitConsentAck: true, targetClass: 0, steps: 10 },
    });
    expect(res.success).toBe(true);
    expect((res.data as any).targetClass).toBe(0);
  });

  it('runs infer_layer_roles and returns semantic classifications', async () => {
    const res = await runReverseTool({
      action: 'infer_layer_roles',
      target: ggufFixture,
      authorization: 'lab',
      options: { format: 'gguf' },
    });
    expect(res.success).toBe(true);
    expect((res.data as any).layers.length).toBeGreaterThan(0);
    expect((res.data as any).layers[0].semanticRole).toBeDefined();
  });

  it('runs trace_layer_execution and caches intermediate layer activations', async () => {
    const cacheDir = path.join(os.tmpdir(), `rev-tool-cache-${Date.now()}`);
    try {
      const res = await runReverseTool({
        action: 'trace_layer_execution',
        target: ggufFixture,
        authorization: 'lab',
        options: { format: 'gguf', cacheDir },
      });
      expect(res.success).toBe(true);
      expect((res.data as any).steps.length).toBe(2);
    } finally {
      if (fs.existsSync(cacheDir)) {
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }
    }
  });

  it('rejects options.output with path traversal attempt', async () => {
    const res = await runReverseTool({
      action: 'extract_model_layer',
      target: ggufFixture,
      authorization: 'lab',
      options: { layer: 'blk.0.attn_q.weight', output: '../../traversal.safetensors' },
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Path traversal disallowed');
  });

  it('runs analyze_model_layer and computes weight statistics', async () => {
    const res = await runReverseTool({
      action: 'analyze_model_layer',
      target: ggufFixture,
      authorization: 'lab',
      options: { layer: 'blk.0.attn_q.weight', format: 'gguf' },
    });
    expect(res.success).toBe(true);
    expect((res.data as any).frobeniusNorm).toBeGreaterThan(0);
    expect((res.data as any).elementCount).toBe(16);
  });
});
