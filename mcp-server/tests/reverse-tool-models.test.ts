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

  it('rejects options.cacheDir with path traversal attempt', async () => {
    const res = await runReverseTool({
      action: 'trace_layer_execution',
      target: ggufFixture,
      authorization: 'lab',
      options: { format: 'gguf', cacheDir: '../../cache-traversal' },
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Path traversal disallowed');
  });

  it('runs extract_model_layer to extract weights to safetensors', async () => {
    const tmpOut = path.join(os.tmpdir(), `layer-${Date.now()}.safetensors`);
    try {
      const res = await runReverseTool({
        action: 'extract_model_layer',
        target: ggufFixture,
        authorization: 'lab',
        options: { layer: 'blk.0.attn_q.weight', output: tmpOut, format: 'gguf' },
      });
      expect(res.success).toBe(true);
      expect((res.data as any).layerName).toBe('blk.0.attn_q.weight');
      expect((res.data as any).format).toBe('safetensors');
      expect(fs.existsSync(tmpOut)).toBe(true);
    } finally {
      if (fs.existsSync(tmpOut)) {
        fs.rmSync(tmpOut, { force: true });
      }
    }
  });

  it('maps legacy inspect_gguf action to inspect_model', async () => {
    const res = await runReverseTool({
      action: 'inspect_gguf' as any,
      target: ggufFixture,
      authorization: 'lab',
      options: { format: 'gguf' },
    });
    expect(res.success).toBe(true);
    expect((res.data as any).format).toBe('gguf');
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

  it('supports explicit async background execution and status polling', async () => {
    const sessionId = `async-test-${Date.now()}`;
    const initialRes = await runReverseTool({
      action: 'inspect_model',
      target: ggufFixture,
      authorization: 'lab',
      sessionId,
      options: { format: 'gguf', async: true },
    });

    expect(initialRes.success).toBe(true);
    expect((initialRes.data as any).status).toBe('running');
    expect((initialRes.data as any).sessionId).toBe(sessionId);

    // Poll until completed
    let statusRes: any;
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100));
      statusRes = await runReverseTool({
        action: 'status',
        sessionId,
      });
      if ((statusRes.data as any)?.status !== 'running') {
        break;
      }
    }

    expect(statusRes.success).toBe(true);
    expect((statusRes.data as any).format).toBe('gguf');
  });

  it('yields running status when execution exceeds sync budget and allows status polling', async () => {
    const sessionId = `budget-test-${Date.now()}`;
    // Provide a tiny 10ms sync budget to trigger async continuation
    const initialRes = await runReverseTool({
      action: 'inspect_model',
      target: ggufFixture,
      authorization: 'lab',
      sessionId,
      options: { format: 'gguf', syncBudgetMs: 10 },
    });

    expect(initialRes.success).toBe(true);
    expect((initialRes.data as any).status).toBe('running');

    // Wait and poll for completion
    let statusRes: any;
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100));
      statusRes = await runReverseTool({
        action: 'status',
        sessionId,
      });
      if ((statusRes.data as any)?.status !== 'running') {
        break;
      }
    }

    expect(statusRes.success).toBe(true);
    expect((statusRes.data as any).format).toBe('gguf');
  });

  it('supports action: abort on background runs', async () => {
    const sessionId = `abort-test-${Date.now()}`;
    await runReverseTool({
      action: 'inspect_model',
      target: ggufFixture,
      authorization: 'lab',
      sessionId,
      options: { format: 'gguf', async: true },
    });

    const abortRes = await runReverseTool({
      action: 'abort',
      sessionId,
    });

    expect(abortRes.success).toBe(true);
    expect(abortRes.action).toBe('abort');
    expect((abortRes.data as any).sessionId).toBe(sessionId);

    const statusAfterAbort = await runReverseTool({
      action: 'status',
      sessionId,
    });
    expect((statusAfterAbort.data as any)?.status).toBe('aborted');
  });

  it('prevents duplicate concurrent runs if runKey is already running', async () => {
    const sessionId = `duplicate-test-${Date.now()}`;
    const firstRes = await runReverseTool({
      action: 'inspect_model',
      target: ggufFixture,
      authorization: 'lab',
      sessionId,
      options: { format: 'gguf', async: true },
    });
    expect(firstRes.success).toBe(true);

    const dupRes = await runReverseTool({
      action: 'inspect_model',
      target: ggufFixture,
      authorization: 'lab',
      sessionId,
      options: { format: 'gguf', async: true },
    });
    expect(dupRes.success).toBe(true);
    expect((dupRes.data as any).status).toBe('running');
    expect((dupRes.data as any).message).toContain('already in progress');
  });
  it('rejects model target with path traversal attempt', async () => {
    const res = await runReverseTool({
      action: 'inspect_model',
      target: '../../traversal.gguf',
      authorization: 'lab',
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Path traversal disallowed in target');
  });

  it('rejects extract_model_layer when options.layer is missing', async () => {
    const res = await runReverseTool({
      action: 'extract_model_layer',
      target: ggufFixture,
      authorization: 'lab',
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('options.layer is required');
  });

  it('rejects analyze_model_layer when options.layer is missing', async () => {
    const res = await runReverseTool({
      action: 'analyze_model_layer',
      target: ggufFixture,
      authorization: 'lab',
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('options.layer is required');
  });

  it('verifies inspect_model reports tensorDataOffset for GGUF', async () => {
    const res = await runReverseTool({
      action: 'inspect_model',
      target: ggufFixture,
      authorization: 'lab',
      options: { format: 'gguf' },
    });
    expect(res.success).toBe(true);
    expect((res.data as any).tensorDataOffset).toBe(256);
  });
});
