import { afterAll, afterEach, beforeAll, describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { handleReverseTool } from '../src/tools/reverse-tool.js';
import { removeDir } from './helpers/temp-dir.js';

const originalPython = process.env.PYTHON;
const originalPythonPath = process.env.PYTHONPATH;
const originalDemucsModelPath = process.env.DEMUCS_MODEL_PATH;
const originalDemucsTestCallLog = process.env.DEMUCS_TEST_CALL_LOG;
const pythonBin = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
let audioFixtureDir = '';
let audioSample = '';
let tempDir: string | undefined;
let generatedOutputDir: string | undefined;

beforeAll(() => {
  audioFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-sample-test-'));
  audioSample = path.join(audioFixtureDir, 'synthetic-30s.wav');
  const makeAudioPy = [
    'import numpy as np',
    'import wave',
    'sample_rate = 44100',
    'time = np.arange(sample_rate * 30, dtype=np.float32) / sample_rate',
    'audio = np.column_stack((0.2 * np.sin(2 * np.pi * 220 * time), 0.2 * np.sin(2 * np.pi * 330 * time)))',
    'pcm = np.clip(audio * 32767, -32768, 32767).astype("<i2")',
    `with wave.open(r'${audioSample}', 'wb') as output:`,
    '    output.setnchannels(2)',
    '    output.setsampwidth(2)',
    '    output.setframerate(sample_rate)',
    '    output.writeframes(pcm.tobytes())',
  ].join(String.fromCharCode(10));
  execFileSync(pythonBin, ['-c', makeAudioPy], { timeout: 15000, encoding: 'utf8' });
});

afterAll(async () => {
  if (audioFixtureDir) await removeDir(audioFixtureDir);
});

afterEach(async () => {
  if (originalPython === undefined) delete process.env.PYTHON;
  else process.env.PYTHON = originalPython;
  if (originalPythonPath === undefined) delete process.env.PYTHONPATH;
  else process.env.PYTHONPATH = originalPythonPath;
  if (originalDemucsModelPath === undefined) delete process.env.DEMUCS_MODEL_PATH;
  else process.env.DEMUCS_MODEL_PATH = originalDemucsModelPath;
  if (originalDemucsTestCallLog === undefined) delete process.env.DEMUCS_TEST_CALL_LOG;
  else process.env.DEMUCS_TEST_CALL_LOG = originalDemucsTestCallLog;
  if (tempDir) await removeDir(tempDir);
  if (generatedOutputDir) await removeDir(generatedOutputDir);
  tempDir = undefined;
  generatedOutputDir = undefined;
});

describe('Audio Stem Separation', () => {
  function makeDemucsMock(): string {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-demucs-test-'));
    const packageDir = path.join(tempDir, 'demucs');
    fs.mkdirSync(packageDir);
    fs.writeFileSync(path.join(packageDir, '__init__.py'), '');
    fs.writeFileSync(path.join(packageDir, 'states.py'), `
class MockModel:
    sources = ['vocals', 'drums', 'bass', 'other']
    samplerate = 44100
    audio_channels = 2
    def eval(self): return self
    def to(self, device): return self

def load_model(checkpoint):
    if checkpoint.get('model') != 'local-htdemucs':
        raise RuntimeError('unexpected local checkpoint')
    return MockModel()
`);
    fs.writeFileSync(path.join(packageDir, 'apply.py'), `
import os
import torch

def apply_model(model, mixture, **kwargs):
    log_path = os.environ.get('DEMUCS_TEST_CALL_LOG')
    if log_path:
        with open(log_path, 'a') as log:
            log.write(str(mixture.shape[-1]) + chr(10))
    scales = torch.tensor([0.2, 0.4, 0.6, 0.8], dtype=mixture.dtype)
    return mixture.repeat(len(model.sources), 1, 1) * scales[:, None, None]
`);
    process.env.PYTHON = pythonBin;
    process.env.PYTHONPATH = [tempDir, originalPythonPath].filter(Boolean).join(path.delimiter);
    return path.join(tempDir, 'local-htdemucs.th');
  }

  it('rejects separation without explicit ownership or licence attestation', async () => {
    const res = await handleReverseTool({
      action: 'separate_audio_stems', target: audioSample, authorization: 'consent',
      options: { method: 'htdemucs' },
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('explicitConsentAck: true');
  });

  it('reports not_available when local Demucs weights are not configured', async () => {
    process.env.PYTHON = pythonBin;
    delete process.env.DEMUCS_MODEL_PATH;

    const res = await handleReverseTool({
      action: 'separate_audio_stems',
      target: audioSample,
      authorization: 'consent',
      options: { method: 'htdemucs', explicitConsentAck: true },
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.status).toBe('not_available');
    expect(data.stems).toEqual({});
    expect(data.error).toContain('no weights were downloaded');
  });

  it('reports not_available when the Demucs backend cannot be imported', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-demucs-unavailable-'));
    const packageDir = path.join(tempDir, 'demucs');
    fs.mkdirSync(packageDir);
    fs.writeFileSync(path.join(packageDir, '__init__.py'), "raise ImportError('mock backend unavailable')");
    const modelPath = path.join(tempDir, 'local-htdemucs.th');
    execFileSync(pythonBin, ['-c', `import torch; torch.save({'model': 'local-htdemucs'}, r'''${modelPath}''')`]);
    process.env.PYTHON = pythonBin;
    process.env.PYTHONPATH = [tempDir, originalPythonPath].filter(Boolean).join(path.delimiter);
    process.env.DEMUCS_MODEL_PATH = modelPath;

    const res = await handleReverseTool({
      action: 'separate_audio_stems',
      target: audioSample,
      authorization: 'consent',
      options: { method: 'htdemucs', explicitConsentAck: true },
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.status).toBe('not_available');
    expect(data.stems).toEqual({});
    expect(data.error).toContain('mock backend unavailable');
  });

  it('honors output directory and caps long input duration', () => {
    const modelPath = makeDemucsMock();
    execFileSync(pythonBin, ['-c', `import torch; torch.save({'model': 'local-htdemucs'}, r'''${modelPath}''')`]);
    process.env.DEMUCS_MODEL_PATH = modelPath;
    const outputParent = path.join(tempDir!, 'chosen-output');
    fs.mkdirSync(outputParent);
    const scriptPath = path.resolve(__dirname, '../scripts/audio_separator.py');

    const output = execFileSync(pythonBin, [
      scriptPath,
      'separate_audio_stems',
      '--file', audioSample,
      '--method', 'htdemucs',
      '--output-dir', outputParent,
      '--max-duration-seconds', '25',
    ], { encoding: 'utf8' });
    const data = JSON.parse(output);

    expect(data.status).toBe('ok');
    expect(data.truncated).toBe(true);
    expect(data.duration_seconds).toBe(25);
    expect(path.dirname(data.output_dir)).toBe(outputParent);
    generatedOutputDir = data.output_dir;
    for (const stem of Object.values(data.stems) as any[]) {
      const wav = fs.readFileSync(stem.path);
      const channels = wav.readUInt16LE(22);
      const dataBytes = wav.readUInt32LE(40);
      expect(dataBytes / (channels * 2)).toBe(25 * data.sample_rate);
    }
  });

  it('returns actual mocked Demucs stem audio and metrics', async () => {
    const modelPath = makeDemucsMock();
    execFileSync(pythonBin, ['-c', `import torch; torch.save({'model': 'local-htdemucs'}, r'''${modelPath}''')`]);
    process.env.DEMUCS_MODEL_PATH = modelPath;
    const callLog = path.join(tempDir!, 'window-sizes.txt');
    process.env.DEMUCS_TEST_CALL_LOG = callLog;

    const res = await handleReverseTool({
      action: 'separate_audio_stems',
      target: audioSample,
      authorization: 'consent',
      options: {
        method: 'htdemucs', stems: ['vocals', 'drums', 'bass', 'other'],
        explicitConsentAck: true, outputDir: path.join(tempDir!, 'handler-output'),
      },
    });

    expect(res.success, JSON.stringify(res)).toBe(true);
    const data = res.data as any;
    expect(data.status).toBe('ok');
    expect(data.backend).toBe('demucs');
    expect(data.model).toBe('htdemucs');
    expect(data.duration_seconds).toBeGreaterThan(0.1);
    expect(data.sample_rate).toBe(44100);
    expect(data.truncated).toBe(false);
    expect(fs.statSync(data.output_dir).isDirectory()).toBe(true);
    generatedOutputDir = data.output_dir;

    const wavs = ['vocals', 'drums', 'bass', 'other'].map(name => {
      const stem = data.stems[name];
      expect(stem.rms_power).toBeTypeOf('number');
      expect(stem.spectral_centroid).toBeTypeOf('number');
      expect(fs.existsSync(stem.path)).toBe(true);
      expect(path.dirname(stem.path)).toBe(data.output_dir);
      const wav = fs.readFileSync(stem.path);
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
      expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
      expect(wav.readUInt32LE(24)).toBe(data.sample_rate);
      const channels = wav.readUInt16LE(22);
      const dataBytes = wav.readUInt32LE(40);
      const frameCount = dataBytes / (channels * 2);
      expect(frameCount).toBe(data.duration_seconds * data.sample_rate);
      return wav.subarray(44, 44 + dataBytes);
    });
    expect(new Set(wavs.map(wav => wav.toString('base64'))).size).toBe(4);
    const windowSizes = fs.readFileSync(callLog, 'utf8').trim().split(/\r?\n/).map(Number);
    expect(windowSizes).toEqual([20 * data.sample_rate, 10 * data.sample_rate]);
    expect(data.learning_notes).toContain('Complete WAV stems');
  });
});
