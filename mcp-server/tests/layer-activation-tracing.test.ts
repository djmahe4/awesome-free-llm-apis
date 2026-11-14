import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

describe('Sequential Layer Activation Tracing', () => {
  const scriptPath = path.resolve(__dirname, '../scripts/model_inspector.py');
  const ggufFixture = path.resolve(__dirname, 'fixtures/models/tiny.gguf');
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir && fs.existsSync(tempDir)) {
      await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 10 });
    }
  });

  it('traces execution across sequential layers and caches intermediate activations', async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'layer-trace-'));

    const rawOut = execFileSync('python', [
      scriptPath,
      'trace_execution',
      '--file', ggufFixture,
      '--format', 'gguf',
      '--cache-dir', tempDir
    ], { encoding: 'utf8' });

    const result = JSON.parse(rawOut);

    expect(result.steps.length).toBe(2);
    expect(fs.existsSync(result.steps[0].cachedFile)).toBe(true);
    expect(result.steps[1].receivedFromPreviousLayer).toBe(true);
  });
});
