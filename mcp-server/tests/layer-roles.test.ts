import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

describe('Semantic Layer Role Inversion', () => {
  const scriptPath = path.resolve(__dirname, '../scripts/model_inspector.py');
  const ggufFixture = path.resolve(__dirname, 'fixtures/models/tiny.gguf');

  it('reverse engineers layer purpose into semantic roles', () => {
    const rawOut = execFileSync('python', [
      scriptPath,
      'infer_roles',
      '--file', ggufFixture,
      '--format', 'gguf'
    ], { encoding: 'utf8' });

    const result = JSON.parse(rawOut);
    expect(result.layers.length).toBe(2);

    const qkvLayer = result.layers.find((l: any) => l.name.includes('attn_q'));
    expect(qkvLayer).toBeDefined();
    expect(qkvLayer.semanticRole).toBe('self_attention_query');
    expect(qkvLayer.functionalCategory).toBe('attention');

    const ffnLayer = result.layers.find((l: any) => l.name.includes('ffn_down'));
    expect(ffnLayer).toBeDefined();
    expect(ffnLayer.semanticRole).toBe('feed_forward_down_projection');
    expect(ffnLayer.functionalCategory).toBe('mlp');
  });
});
