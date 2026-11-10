import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { handleReverseTool } from '../src/tools/reverse-tool.js';

describe('Audio Stem Separation & Spectral Decomposition Engine', () => {
  const audioSample = path.resolve(__dirname, 'fixtures/media/audio/sample_match_audio.wav');

  it('separates audio into 4 stems with spectral metrics', async () => {
    const res = await handleReverseTool({
      action: 'separate_audio_stems',
      target: audioSample,
      authorization: 'lab',
      options: {
        method: 'spectral_multiband',
        stems: ['vocals', 'drums', 'bass', 'other'],
      },
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.stems).toBeDefined();
    expect(data.stems.vocals).toBeDefined();
    expect(data.stems.drums).toBeDefined();
    expect(data.stems.bass).toBeDefined();
    expect(data.stems.other).toBeDefined();
    expect(data.stems.vocals.rms_power).toBeTypeOf('number');
    expect(data.stems.vocals.spectral_centroid).toBeTypeOf('number');
    expect(data.learning_notes).toContain('STFT');
  });
});