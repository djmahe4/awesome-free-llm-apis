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

export interface SandboxOptions {
  data?: string;
  timeoutMs?: number;
  language?: SandboxLanguage;
}

/**
 * Execute code in an isolated, network-free, filesystem-free sandbox.
 */
export async function executeInSandbox(
  code: string,
  options: SandboxOptions = {}
): Promise<ExecutionResult> {
  const { data = '', timeoutMs = 5000, language = 'javascript' } = options;
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

/**
 * Resolve the absolute path to the Python executable.
 * Prefers local venv/ or .venv/ if they exist, supporting cross-platform paths.
 */
function resolvePythonPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const isWindows = process.platform === 'win32';
  const venvNames = ['venv', '.venv'];
  const binDir = isWindows ? 'Scripts' : 'bin';
  const pythonExe = isWindows ? 'python.exe' : 'python3';

  // Try going up to find workspace root robustly
  // src/sandbox/executor.ts → ../..
  // dist/src/sandbox/executor.js → ../../..
  const roots = [
    path.resolve(__dirname, '..', '..'),
    path.resolve(__dirname, '..', '..', '..'),
  ];

  for (const root of roots) {
    for (const venvName of venvNames) {
      const fullPath = path.resolve(root, venvName, binDir, pythonExe);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  return isWindows ? 'python.exe' : 'python3';
}

async function executePython(
  code: string,
  data: string,
  timeoutMs: number
): Promise<ExecutionResult> {
  const startTime = Date.now();
  const scriptPath = resolveRunnerPath('python-sandbox-runner.py');
  const pythonPath = resolvePythonPath();

  try {
    const result = await runSubprocessWithStdin(pythonPath, [scriptPath], code, {
      timeout: timeoutMs,
      env: { SANDBOX_DATA: data },
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      success: result.success,
      error: result.error,
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
        ? `${pythonPath} is not available. Install Python 3 to use language:"python".`
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
    const result = await runSubprocessWithStdin(binaryPath, [], code, {
      timeout: timeoutMs,
      env: {
        SANDBOX_DATA: data,
        SANDBOX_TIMEOUT_MS: String(timeoutMs),
      },
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      success: result.success,
      error: result.error,
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

/**
 * Helper to run a subprocess with stdin input and captured output.
 */
async function runSubprocessWithStdin(
  command: string,
  args: string[],
  input: string,
  options: { timeout?: number; env?: Record<string, string> }
): Promise<ExecutionResult & { code: number | null }> {
  const startTime = Date.now();
  const { spawn } = await import('child_process');

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;

    const timeout = options.timeout
      ? setTimeout(() => {
        killedByTimeout = true;
        child.kill('SIGKILL');
      }, options.timeout)
      : null;

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err: any) => {
      if (timeout) clearTimeout(timeout);
      resolve({
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        success: false,
        error: err.code === 'ENOENT' ? `${command} not found` : err.message,
        executionTimeMs: Date.now() - startTime,
        code: null,
      });
    });

    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout);
      resolve({
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        success: code === 0 && !killedByTimeout,
        error: killedByTimeout ? 'Execution timed out' : (code !== 0 ? `Subprocess failed with code ${code}` : undefined),
        executionTimeMs: Date.now() - startTime,
        code,
      });
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}
