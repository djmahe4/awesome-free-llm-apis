import { executeInSandbox } from '../sandbox/executor.js';
import { MemoryManager } from '../memory/index.js';

export interface CodeModeInput {
  code: string;
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
  const { code, data = '', timeout_ms = 5000 } = input;

  const result = await executeInSandbox(code, data, timeout_ms);

  const compressionRatio = data.length > 0 ? result.stdout.length / data.length : undefined;

  if (data.length > 0) {
    await memoryManager.storeCompressionStats(data.length, result.stdout.length, 'code_mode');
  }

  return {
    ...result,
    compressionRatio,
  };
}
