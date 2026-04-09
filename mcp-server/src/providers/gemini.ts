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
  ];

  /** Attempt to locate the venv Python interpreter relative to the project root */
  private resolvePythonPath(): string {
    if (process.env.PYTHON_EXECUTABLE) return process.env.PYTHON_EXECUTABLE;

    const projectRoot = path.resolve(__dirname, '../../');
    const isWin = process.platform === 'win32';

    // Windows: .venv\Scripts\python.exe, venv\Scripts\python.exe
    // Unix: .venv/bin/python3, venv/bin/python3
    const possibleVenvs = [
      isWin ? path.join(projectRoot, '.venv', 'Scripts', 'python.exe') : path.join(projectRoot, '.venv', 'bin', 'python3'),
      isWin ? path.join(projectRoot, 'venv', 'Scripts', 'python.exe') : path.join(projectRoot, 'venv', 'bin', 'python3')
    ];

    for (const venvPython of possibleVenvs) {
      if (existsSync(venvPython)) return venvPython;
    }

    // Fallback to system python
    return isWin ? 'python' : 'python3';
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

    const actualModel = request.model || 'gemini-2.5-flash';
    let result;
    try {
      result = await this.runPythonClient({
        model: actualModel,
        messages: request.messages,
        stream: false,
        temperature: request.temperature,
        response_format: request.response_format,
        google_search: request.google_search,
      });
    } catch (err: any) {
      const error = new Error(`Gemini Error: ${err.message}`);
      const msg = err.message.toLowerCase();
      if (msg.includes('429') || msg.includes('quota') || msg.includes('exhausted')) {
        (error as any).status = 429;
      } else {
        (error as any).status = 500;
      }
      throw error;
    }

    if (result.type === 'error') {
      const error = new Error(result.message);
      const msg = result.message.toLowerCase();
      if (msg.includes('429') || msg.includes('quota') || msg.includes('exhausted')) {
        (error as any).status = 429;
      } else {
        (error as any).status = 500;
      }
      throw error;
    }

    // Success
    this.recordRequest();
    this.consecutiveFailures = 0;
    this.cooldownUntil = 0;

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
      model: actualModel,
      object: 'chat.completion',
      created: Date.now(),
    };
  }

  async *chatStream(request: ChatRequest): AsyncIterable<string> {
    this.checkRateLimit();

    const pythonPath = this.resolvePythonPath();
    const scriptPath = path.join(__dirname, 'gemini_client.py');

    const py = spawn(pythonPath, [scriptPath], {
      env: { ...process.env }
    });
    const input = JSON.stringify({
      model: request.model || 'gemini-2.5-flash',
      messages: request.messages,
      stream: true,
      temperature: request.temperature,
      response_format: request.response_format,
      google_search: request.google_search,
    });

    py.stdin.write(input);
    py.stdin.end();

    let buffer = '';
    let stderrStr = '';
    py.stderr.on('data', (d) => { stderrStr += d.toString(); });

    let hasError = false;

    try {
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
              const error = new Error(`Gemini Stream Error: ${chunk.message}`);
              const msg = chunk.message.toLowerCase();
              if (msg.includes('429') || msg.includes('quota') || msg.includes('exhausted')) {
                (error as any).status = 429;
              } else {
                (error as any).status = 500;
              }
              throw error;
            }
          } catch (e: any) {
            if (e.status) throw e;
            // Otherwise it's just a malformed chunk, ignore
          }
        }
      }
    } catch (e) {
      hasError = true;
      throw e;
    } finally {
      if (!hasError && stderrStr.trim()) {
        const msg = stderrStr.toLowerCase();
        if (msg.includes('error') || msg.includes('traceback') || msg.includes('exception')) {
          const isRateLimit = msg.includes('429') || msg.includes('quota') || msg.includes('exhausted');
          const error = new Error(`Gemini Stderr: ${stderrStr}`);
          (error as any).status = isRateLimit ? 429 : 500;
          throw error;
        }
      }

      if (!hasError) {
        this.recordRequest();
        this.consecutiveFailures = 0;
        this.cooldownUntil = 0;
      }
    }
  }
}
