import { spawn } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BaseProvider } from './base.js';
import type { ChatRequest, ChatResponse, ProviderModel, RateLimits } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class GeminiProvider extends BaseProvider {
  name = 'Google Gemini';
  id = 'gemini';
  baseURL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
  envVar = 'GEMINI_API_KEY';
  rateLimits: RateLimits = { rpm: 15, rpd: 1000 };
  models: ProviderModel[] = [
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview' },
    { id: 'gemini-3.1-flash-preview', name: 'Gemini 3.1 Flash Preview' },
    { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview' },
    { id: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash Lite Preview' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
  ];

  /** Attempt to locate the venv Python interpreter relative to the project root */
  private resolvePythonPath(): string {
    if (process.env.PYTHON_EXECUTABLE) return process.env.PYTHON_EXECUTABLE;
    // Walk up from dist/providers → dist → project root, then look for venv
    const projectRoot = path.resolve(__dirname, '../../');
    const venvPython = path.join(projectRoot, 'venv', 'bin', 'python3');
    return existsSync(venvPython) ? venvPython : 'python3';
  }

  private async runPythonClient(request: any): Promise<any> {
    const pythonPath = this.resolvePythonPath();
    const scriptPath = path.join(__dirname, 'gemini_client.py');
    if (process.env.DEBUG) {
      console.error(`[Gemini] Spawning Python: ${pythonPath} with script: ${scriptPath}`);
    }

    return new Promise((resolve, reject) => {
      const py = spawn(pythonPath, [scriptPath], {
        env: { ...process.env }
      });
      const input = JSON.stringify({
        ...request,
      });

      let stdout = '';
      let stderr = '';

      py.stdin.write(input);
      py.stdin.end();

      py.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      py.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      py.on('close', (code) => {
        if (code !== 0) {
          try {
            const err = JSON.parse(stderr);
            reject(new Error(err.message || stderr));
          } catch {
            reject(new Error(stderr || `Python exit code ${code}`));
          }
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Failed to parse Python output'));
        }
      });
    });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.checkRateLimit();
    this.recordRequest();

    const result = await this.runPythonClient({
      model: request.model,
      messages: request.messages,
      stream: false,
      temperature: request.temperature,
    });

    if (result.type === 'error') {
      throw new Error(result.message);
    }

    return {
      id: `gemini-${Date.now()}`,
      choices: [
        {
          message: {
            role: 'assistant',
            content: result.text,
          },
          finish_reason: 'stop',
          index: 0,
        },
      ],
      usage: result.usage,
      model: request.model,
      object: 'chat.completion',
      created: Date.now(),
    };
  }

  async *chatStream(request: ChatRequest): AsyncIterable<string> {
    this.checkRateLimit();
    this.recordRequest();

    const pythonPath = process.env.PYTHON_EXECUTABLE ?? 'python3';
    const scriptPath = path.join(__dirname, 'gemini_client.py');

    const py = spawn(pythonPath, [scriptPath], {
      env: { ...process.env }
    });
    const input = JSON.stringify({
      model: request.model,
      messages: request.messages,
      stream: true,
      temperature: request.temperature,
    });

    py.stdin.write(input);
    py.stdin.end();

    let buffer = '';
    for await (const data of py.stdout) {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.type === 'chunk') {
            yield chunk.text;
          } else if (chunk.type === 'error') {
            throw new Error(chunk.message);
          }
        } catch (e) {
          console.error('Error parsing Gemini stream chunk:', e);
        }
      }
    }
  }
}
