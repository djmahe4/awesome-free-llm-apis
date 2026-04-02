import { executeInSandbox } from '../sandbox/executor.js';
import { MemoryManager } from '../memory/index.js';

export type CodeLanguage = 'javascript' | 'python' | 'go' | 'rust';

export interface CodeModeInput {
  code: string;
  language?: CodeLanguage;
  data?: string;
  command?: string;
  timeout_ms?: number;
}

export interface CodeModeResult {
  stdout: string;
  stderr: string;
  success: boolean;
  error?: string;
  executionTimeMs: number;
  compressionRatio?: number;
}

const memoryManager = new MemoryManager();

export async function runCodeMode(input: CodeModeInput): Promise<CodeModeResult> {
  const { code, language = 'javascript', data = '', timeout_ms = 5000 } = input;

  const result = await executeInSandbox(code, data, timeout_ms, language);

  const compressionRatio = data.length > 0 ? result.stdout.length / data.length : undefined;

  if (data.length > 0) {
    await memoryManager.storeCompressionStats(data.length, result.stdout.length, 'code_mode');
  }

  return {
    ...result,
    compressionRatio,
  };
}
