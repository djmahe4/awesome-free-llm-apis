import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

describe('ONNX Model Inspector', () => {
  const scriptPath = path.resolve(__dirname, '../scripts/model_inspector.py');
  const onnxFixture = path.resolve(__dirname, 'fixtures/models/tiny.onnx');

  it('inspects ONNX ModelProto header, opset, and graph structure', () => {
    const rawOut = execFileSync('python', [
      scriptPath,
      'inspect',
      '--file', onnxFixture,
      '--format', 'onnx'
    ], { encoding: 'utf8' });

    const result = JSON.parse(rawOut);
    expect(result.format).toBe('onnx');
    expect(result.irVersion).toBe(8);
    expect(result.producerName).toBe('model_inspector_test');
    expect(result.opsetVersion).toBe(17);
  });
});
