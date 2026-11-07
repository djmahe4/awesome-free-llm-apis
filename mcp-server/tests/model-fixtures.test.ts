import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Model Artifact Fixtures', () => {
  const fixturesDir = path.resolve(__dirname, 'fixtures/models');

  it('contains valid minimal synthetic model fixtures', () => {
    const ggufFile = path.join(fixturesDir, 'tiny.gguf');
    const onnxFile = path.join(fixturesDir, 'tiny.onnx');
    const ptFile = path.join(fixturesDir, 'tiny.pt');

    expect(fs.existsSync(ggufFile)).toBe(true);
    expect(fs.existsSync(onnxFile)).toBe(true);
    expect(fs.existsSync(ptFile)).toBe(true);

    // GGUF magic check: 0x46554747 ('GGUF')
    const ggufBuf = fs.readFileSync(ggufFile);
    expect(ggufBuf.subarray(0, 4).toString('ascii')).toBe('GGUF');

    // PyTorch ZIP check: PK\x03\x04
    const ptBuf = fs.readFileSync(ptFile);
    expect(ptBuf.subarray(0, 2).toString('ascii')).toBe('PK');
  });
});
