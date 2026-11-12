import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { handleReverseTool } from '../src/tools/reverse-tool.js';

describe('OCR Token Bounding & Layout Engine', () => {
  const framePath = path.resolve(__dirname, 'fixtures/media/frames/frame_0050.jpg');

  it('detects text tokens and extracts spatial bounding coordinates', async () => {
    const res = await handleReverseTool({
      action: 'inspect_ocr_tokens',
      target: framePath,
      authorization: 'lab',
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(Array.isArray(data.tokens)).toBe(true);
    expect(data.tokens.length).toBeGreaterThan(0);
    const first = data.tokens[0];
    expect(first.text).toBeTypeOf('string');
    expect(first.bbox).toHaveLength(4); // [x, y, w, h]
    expect(first.confidence).toBeGreaterThanOrEqual(0);
    expect(data.reading_order).toBeDefined();
    expect(data.layout_blocks).toBeDefined();
    expect(data.learning_notes).toContain('Spatial Grounding');
  });
});
