import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

export type SandboxLanguage = 'javascript' | 'python' | 'go' | 'rust';

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  success: boolean;
  error?: string;
  executionTimeMs: number;
}

/**
 * Resolve the absolute path to a sandbox runner script/binary relative to this file.
 * Works for both source (src/) and compiled (dist/) layouts.
 */
function resolveRunnerPath(...segments: string[]): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // src/sandbox/executor.ts → ../../scripts/...
  // dist/src/sandbox/executor.js → ../../../scripts/...
  // Try going up to find the scripts dir robustly
  const candidates = [
    path.resolve(__dirname, '..', '..', 'scripts', ...segments),       // src layout
    path.resolve(__dirname, '..', '..', '..', 'scripts', ...segments), // dist layout
  ];
  return candidates.find(c => fs.existsSync(c)) || candidates[0];
}

/**
 * Execute code in an isolated, network-free, filesystem-free sandbox.
 */
export async function executeInSandbox(
  code: string,
  data: string = '',
  timeoutMs: number = 5000,
  language: SandboxLanguage = 'javascript'
): Promise<ExecutionResult> {
  switch (language) {
    case 'javascript':
      return executeJavaScript(code, data, timeoutMs);
    case 'python':
      return executePython(code, data, timeoutMs);
    case 'go':
      return executeSubprocessRunner(
        resolveRunnerPath('go-sandbox-runner', 'sandbox-runner'),
        'go',
        code,
        data,
        timeoutMs
      );
    case 'rust':
      return executeSubprocessRunner(
        resolveRunnerPath('rust-sandbox-runner', 'target', 'release', 'sandbox-runner'),
        'rust',
        code,
        data,
        timeoutMs
      );
    default:
      return {
        stdout: '',
        stderr: '',
        success: false,
        error: `Unknown language: "${language}". Supported: javascript, python, go, rust.`,
        executionTimeMs: 0,
      };
  }
}

// ---------------------------------------------------------------------------
// JavaScript — QuickJS (quickjs-emscripten), in-process
// ---------------------------------------------------------------------------

async function executeJavaScript(
  code: string,
  data: string,
  timeoutMs: number
): Promise<ExecutionResult> {
  const startTime = Date.now();
  const QuickJS = await getQuickJS();
  const context = QuickJS.newContext();
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  try {
    const dataHandle = context.newString(data);
    context.setProp(context.global, 'DATA', dataHandle);
    dataHandle.dispose();

    const printFn = context.newFunction('print', (...args) => {
      stdoutLines.push(args.map((a) => context.dump(a)).join(' '));
    });
    context.setProp(context.global, 'print', printFn);
    printFn.dispose();

    const consolObj = context.newObject();
    const logFn = context.newFunction('log', (...args) => {
      stdoutLines.push(args.map((a) => context.dump(a)).join(' '));
    });
    const errorFn = context.newFunction('error', (...args) => {
      stderrLines.push(args.map((a) => context.dump(a)).join(' '));
    });
    context.setProp(consolObj, 'log', logFn);
    context.setProp(consolObj, 'error', errorFn);
    context.setProp(context.global, 'console', consolObj);
    logFn.dispose();
    errorFn.dispose();
    consolObj.dispose();

    const deadline = Date.now() + timeoutMs;
    context.runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));

    const result = context.evalCode(code);

    if (result.error) {
      const errorMsg = context.dump(result.error);
      result.error.dispose();
      const timedOut = Date.now() >= deadline;
      return {
        stdout: stdoutLines.join('\n'),
        stderr: stderrLines.join('\n'),
        success: false,
        error: timedOut ? 'Execution timed out' : String(errorMsg),
        executionTimeMs: Date.now() - startTime,
      };
    }

    result.value.dispose();
    return {
      stdout: stdoutLines.join('\n'),
      stderr: stderrLines.join('\n'),
      success: true,
      executionTimeMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      stdout: stdoutLines.join('\n'),
      stderr: stderrLines.join('\n'),
      success: false,
      error: err instanceof Error ? err.message : String(err),
      executionTimeMs: Date.now() - startTime,
    };
  } finally {
    context.dispose();
  }
}

// ---------------------------------------------------------------------------
// Python — RestrictedPython subprocess runner
// ---------------------------------------------------------------------------

async function executePython(
  code: string,
  data: string,
  timeoutMs: number
): Promise<ExecutionResult> {
  const startTime = Date.now();
  const scriptPath = resolveRunnerPath('python-sandbox-runner.py');

  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const { stdout, stderr } = await execFileAsync('python3', [scriptPath], {
      input: code,
      timeout: timeoutMs,
      env: { ...process.env, SANDBOX_DATA: data },
      maxBuffer: 1024 * 1024,
    } as any);

    return {
      stdout: (stdout as unknown as string).trimEnd(),
      stderr: (stderr as unknown as string).trimEnd(),
      success: true,
      executionTimeMs: Date.now() - startTime,
    };
  } catch (err: any) {
    const timedOut = err.killed || err.code === 'ETIMEDOUT';
    const notFound = err.code === 'ENOENT';
    return {
      stdout: err.stdout?.trimEnd() ?? '',
      stderr: err.stderr?.trimEnd() ?? '',
      success: false,
      error: notFound
        ? 'python3 is not available on PATH. Install Python 3 to use language:"python".'
        : timedOut
          ? 'Execution timed out'
          : err.message ?? String(err),
      executionTimeMs: Date.now() - startTime,
    };
  }
}

// ---------------------------------------------------------------------------
// Go / Rust — subprocess runner
// ---------------------------------------------------------------------------

async function executeSubprocessRunner(
  binaryPath: string,
  langLabel: string,
  code: string,
  data: string,
  timeoutMs: number
): Promise<ExecutionResult> {
  const startTime = Date.now();

  try {
    const { access } = await import('fs/promises');
    await access(binaryPath);
  } catch {
    const buildCmd =
      langLabel === 'go'
        ? 'cd scripts/go-sandbox-runner && go build -o sandbox-runner .'
        : 'cd scripts/rust-sandbox-runner && cargo build --release';
    return {
      stdout: '',
      stderr: '',
      success: false,
      error:
        `The ${langLabel} sandbox runner binary was not found at: ${binaryPath}\n` +
        `Build it first with:\n  ${buildCmd}`,
      executionTimeMs: 0,
    };
  }

  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const { stdout, stderr } = await execFileAsync(binaryPath, [], {
      input: code,
      timeout: timeoutMs,
      env: {
        ...process.env,
        SANDBOX_DATA: data,
        SANDBOX_TIMEOUT_MS: String(timeoutMs),
      },
      maxBuffer: 1024 * 1024,
    } as any);

    return {
      stdout: (stdout as unknown as string).trimEnd(),
      stderr: (stderr as unknown as string).trimEnd(),
      success: true,
      executionTimeMs: Date.now() - startTime,
    };
  } catch (err: any) {
    const timedOut = err.killed || err.code === 'ETIMEDOUT';
    return {
      stdout: err.stdout?.trimEnd() ?? '',
      stderr: err.stderr?.trimEnd() ?? '',
      success: false,
      error: timedOut ? 'Execution timed out' : err.message ?? String(err),
      executionTimeMs: Date.now() - startTime,
    };
  }
}
