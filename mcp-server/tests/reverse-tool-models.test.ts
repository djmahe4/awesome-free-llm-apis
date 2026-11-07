import { describe, it, expect } from 'vitest';
import { runReverseTool } from '../src/tools/reverse-tool.js';
import * as path from 'node:path';

describe('reverse_tool Model Introspection Actions', () => {
  const ggufFixture = path.resolve(__dirname, 'fixtures/models/tiny.gguf');
  const ptFixture = path.resolve(__dirname, 'fixtures/models/tiny.pt');

  it('runs inspect_model through runReverseTool()', async () => {
    const res = await runReverseTool({
      action: 'inspect_model',
      target: ggufFixture,
      options: { format: 'gguf' }
    });
    expect(res.success).toBe(true);
    expect((res.data as any).format).toBe('gguf');
  });

  it('rejects reconstruct_training_samples without explicit consent authorization', async () => {
    const res = await runReverseTool({
      action: 'reconstruct_training_samples',
      target: ptFixture,
      authorization: 'lab' // Not consent!
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('consent');
  });

  it('runs reconstruct_training_samples with consent authorization', async () => {
    const res = await runReverseTool({
      action: 'reconstruct_training_samples',
      target: ptFixture,
      authorization: 'consent',
      options: { explicitConsentAck: true, targetClass: 0, steps: 10 }
    });
    expect(res.success).toBe(true);
    expect((res.data as any).targetClass).toBe(0);
  });
});
