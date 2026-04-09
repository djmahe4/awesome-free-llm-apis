import * as path from 'path';
import * as fs from 'fs-extra';
import { executeInSandbox } from '../sandbox/executor.js';
import { MemoryManager } from '../memory/index.js';

export type CodeLanguage = 'javascript' | 'python' | 'go' | 'rust';
// v1.0.4: Supported execution modes
export type CodeModeType = 'chat' | 'coding' | 'research';

export interface CodeModeInput {
  code: string;
  language?: CodeLanguage;
  data?: string;
  command?: string;
  timeout_ms?: number;
  // v1.0.4: Optional session and mode for stateful coding mode
  sessionId?: string;
  mode?: CodeModeType;
}

export interface CodeModeResult {
  stdout: string;
  stderr: string;
  success: boolean;
  error?: string;
  executionTimeMs: number;
  compressionRatio?: number;
  // v1.0.4: Detected or provided execution mode
  mode?: CodeModeType;
  filesWritten?: string[];
}

const memoryManager = new MemoryManager();

// v1.0.4: Detect execution mode from code content and command description
function detectMode(code: string, command?: string): CodeModeType {
  const text = `${code} ${command ?? ''}`;
  const codingPatterns = /\b(file|write|edit|create|generate|function|class|interface|export|import|const|let|var|def|struct)\b/i;
  const researchPatterns = /\b(search|fetch|request|url|http|api|lookup|query|find|browse|retrieve)\b/i;
  if (codingPatterns.test(text)) return 'coding';
  if (researchPatterns.test(text)) return 'research';
  return 'chat';
}

// v1.0.4: Write a file into the session's persistent project directory
async function writeToSessionMemory(sessionId: string, filePath: string, content: string) {
  const base = path.join(process.cwd(), 'data', 'projects', sessionId);
  const safePath = path.resolve(base, filePath);
  if (!safePath.startsWith(base)) throw new Error('Path traversal blocked');
  await fs.ensureDir(path.dirname(safePath));
  await fs.writeFile(safePath, content, 'utf-8');
}

// v1.0.4: Parse ```file:<path>``` blocks from sandbox output
function parseFileBlocks(output: string): Array<{ filePath: string; content: string }> {
  const FILE_BLOCK_RE = /```file:([^\n]+)\n([\s\S]*?)```/g;
  const files: Array<{ filePath: string; content: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = FILE_BLOCK_RE.exec(output)) !== null) {
    files.push({ filePath: match[1].trim(), content: match[2] });
  }
  return files;
}

export async function runCodeMode(input: CodeModeInput): Promise<CodeModeResult> {
  const { code, language = 'javascript', data = '', timeout_ms = 5000, sessionId, mode: inputMode } = input;

  // v1.0.4: Resolve mode — explicit input wins, otherwise auto-detect from code content
  const mode: CodeModeType = inputMode ?? detectMode(code, input.command);

  const result = await executeInSandbox(code, {
    data,
    timeoutMs: timeout_ms,
    language
  });

  const compressionRatio = data.length > 0 ? result.stdout.length / data.length : undefined;

  if (data.length > 0) {
    await memoryManager.storeCompressionStats(data.length, result.stdout.length, 'code_mode');
  }

  const filesWritten: string[] = [];

  // v1.0.4: In coding mode, persist any ```file:...``` blocks from stdout to session memory
  if (mode === 'coding' && sessionId && result.success && result.stdout) {
    const fileBlocks = parseFileBlocks(result.stdout);
    for (const { filePath, content } of fileBlocks) {
      try {
        await writeToSessionMemory(sessionId, filePath, content);
        filesWritten.push(filePath);
      } catch (err) {
        console.error(`[code-mode] Failed to write file ${filePath}: ${err}`);
      }
    }
  }

  return {
    ...result,
    compressionRatio,
    mode,
    ...(filesWritten.length > 0 ? { filesWritten } : {}),
  };
}
