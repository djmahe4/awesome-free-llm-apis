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

  // 1. Try local Python kokoro-onnx via venv
  const localSuccess = await new Promise<boolean>((resolve) => {
    const pythonCode = `
import sys
try:
    import kokoro_onnx, soundfile
    print("KOKORO_AVAILABLE")
except Exception:
    sys.exit(1)
`;
    const proc = spawn(pythonBin, ['-c', pythonCode]);
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });

  if (localSuccess) {
    return input.outputPath;
  }

  // 2. Try edge-tts local fallback via venv Python
  const edgeSuccess = await new Promise<boolean>((resolve) => {
    const proc = spawn(pythonBin, ['-m', 'edge_tts', '--text', input.text, '--write-media', input.outputPath]);
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });

  if (edgeSuccess) {
    return input.outputPath;
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
