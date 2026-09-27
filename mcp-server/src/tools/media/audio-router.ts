import { spawn } from 'node:child_process';
import fetch from 'node-fetch';
import fs from 'fs-extra';
import path from 'node:path';

function resolvePython(): string {
  const isWin = process.platform === 'win32';
  const venvPython = isWin
    ? path.resolve(process.cwd(), 'venv', 'Scripts', 'python.exe')
    : path.resolve(process.cwd(), 'venv', 'bin', 'python');
  if (fs.existsSync(venvPython)) return venvPython;
  return isWin ? 'python' : 'python3';
}

export interface TtsInput {
  text: string;
  voice?: string;
  outputPath: string;
  speed?: number;
  usePollinationsCloudFallback?: boolean;
}

/**
 * Synthesizes speech locally using kokoro-onnx on CPU (<200ms).
 * If local Python env lacks kokoro-onnx, automatically falls back to:
 * 1. edge-tts (keyless local CLI)
 * 2. Pollinations hosted `hexgrad/kokoro-82m` cloud endpoint
 */
export async function synthesizeSpeechLocal(input: TtsInput): Promise<string> {
  const pythonBin = resolvePython();
  await fs.ensureDir(path.dirname(input.outputPath));

  // 1. Try local kokoro-onnx if model & voices weights are present
  const modelDir = path.resolve(process.cwd(), 'models', 'kokoro');
  const modelPath = path.join(modelDir, 'kokoro-v1.0.onnx');
  const voicesPath = path.join(modelDir, 'voices-v1.0.bin');

  if (await fs.pathExists(modelPath) && (await fs.pathExists(voicesPath))) {
    const kokoroSuccess = await new Promise<boolean>((resolve) => {
      const script = `
import sys
import soundfile as sf
from kokoro_onnx import Kokoro

try:
    kokoro = Kokoro(r"${modelPath}", r"${voicesPath}")
    samples, sample_rate = kokoro.create(
        ${JSON.stringify(input.text)},
        voice=${JSON.stringify(input.voice || 'af_heart')},
        speed=${input.speed || 1.0},
        lang="en-us"
    )
    sf.write(r"${input.outputPath}", samples, sample_rate)
    sys.exit(0)
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
`;
      const proc = spawn(pythonBin, ['-c', script]);
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });

    if (kokoroSuccess && (await fs.pathExists(input.outputPath))) {
      const stat = await fs.stat(input.outputPath);
      if (stat.size > 0) {
        return input.outputPath;
      }
    }
  }

  // 2. Synthesize speech via local edge-tts CLI (zero-config, high quality)
  const voice = input.voice && input.voice.includes('Neural') ? input.voice : 'en-US-ChristopherNeural';
  const edgeSuccess = await new Promise<boolean>((resolve) => {
    const proc = spawn(pythonBin, ['-m', 'edge_tts', '--voice', voice, '--text', input.text, '--write-media', input.outputPath]);
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });

  if (edgeSuccess && (await fs.pathExists(input.outputPath))) {
    const stat = await fs.stat(input.outputPath);
    if (stat.size > 0) {
      return input.outputPath;
    }
  }

  // 3. Cloud Fallback: Pollinations hosted Kokoro-82M / Qwen-TTS endpoint
  const apiKey = process.env.POLLINATIONS_API_KEY;
  const keyParam = apiKey ? `&key=${apiKey}` : '';
  const cloudUrl = `https://gen.pollinations.ai/audio/${encodeURIComponent(input.text)}?model=hexgrad/kokoro-82m&voice=${input.voice || 'af_heart'}${keyParam}`;

  const res = await fetch(cloudUrl);
  if (res.ok) {
    const buffer = await res.arrayBuffer();
    await fs.writeFile(input.outputPath, Buffer.from(buffer));
    return input.outputPath;
  }

  throw new Error('All speech synthesis backends failed (local kokoro-onnx, edge-tts, and Pollinations cloud)');
}
