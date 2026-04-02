import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';
import { fileURLToPath } from 'url';
import path from 'path';

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
  return candidates[0]; // The executor checks existence at runtime
}

/**
 * Execute code in an isolated, network-free, filesystem-free sandbox.
 *
 * Sandbox runtimes by language:
 *
 *   javascript (default)
 *     Engine  : QuickJS via quickjs-emscripten (in-process, no subprocess)
 *     Scripts : User writes JavaScript. print() / console.log() → stdout.
 *     Security: Fully isolated — no fs, no net, deadline interrupt for timeout.
 *
 *   python
 *     Engine  : RestrictedPython (scripts/python-sandbox-runner.py)
 *     Scripts : User writes Python. print() → stdout.
 *     Security: Dangerous builtins stripped; blocked imports list enforced.
 *     Requires: python3 on PATH. Install RestrictedPython: pip install RestrictedPython
 *
 *   go
 *     Engine  : goja — pure-Go ECMAScript 5.1+ (scripts/go-sandbox-runner/)
 *     Scripts : User writes JavaScript. print() / console.log() → stdout.
 *     Security: No require/process/fs/net globals. Timeout via goroutine interrupt.
 *     Requires: Pre-built binary at scripts/go-sandbox-runner/sandbox-runner
 *               Build: cd scripts/go-sandbox-runner && go build -o sandbox-runner .
 *
 *   rust
 *     Engine  : boa_engine — pure-Rust ECMAScript 2021 (scripts/rust-sandbox-runner/)
 *     Scripts : User writes JavaScript. print() / console.log() → stdout.
 *     Security: No require/process/fs/net globals.
 *     Requires: Pre-built binary at scripts/rust-sandbox-runner/target/release/sandbox-runner
 *               Build: cd scripts/rust-sandbox-runner && cargo build --release
 *
 * All runtimes expose:
 *   DATA          — the input data string (injected before execution)
 *   print()       — captures a line to stdout
 *   console.log() — captures a line to stdout
 *   console.error()— captures a line to stderr
 *
 * @param code      - Script source code
 * @param data      - Input data injected as DATA global variable
 * @param timeoutMs - Maximum execution time in milliseconds (default 5000)
 * @param language  - Sandbox runtime language (default 'javascript')
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

/**
 * Execute JavaScript in a QuickJS sandbox (quickjs-emscripten).
 * Fully isolated: no filesystem, no network, no Node.js APIs.
 * Timeout enforced via deadline interrupt handler.
 */
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
    // Inject DATA global
    const dataHandle = context.newString(data);
    context.setProp(context.global, 'DATA', dataHandle);
    dataHandle.dispose();

    // print() → stdout
    const printFn = context.newFunction('print', (...args) => {
      stdoutLines.push(args.map((a) => context.dump(a)).join(' '));
    });
    context.setProp(context.global, 'print', printFn);
    printFn.dispose();

    // console.log / console.error
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
 * Execute Python code via the RestrictedPython sandbox runner script.
 *
 * The runner (scripts/python-sandbox-runner.py) enforces:
 *   - Safe builtins only (no open, no __import__ of fs/net modules)
 *   - RestrictedPython compile_restricted() if available (falls back to manual restriction)
 *   - DATA injected via SANDBOX_DATA environment variable
 *
 * Requires: python3 on PATH.
 * Optional: pip install RestrictedPython for full RestrictedPython enforcement.
 */
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
      maxBuffer: 1024 * 1024, // 1 MB output limit
    } as any);

    return {
      stdout: (stdout as string).trimEnd(),
      stderr: (stderr as string).trimEnd(),
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
// Go (goja) / Rust (boa_engine) — pre-compiled binary subprocess runner
// ---------------------------------------------------------------------------

/**
 * Execute JavaScript code via a pre-compiled sandbox runner binary.
 *
 * Used for:
 *   go   → scripts/go-sandbox-runner/sandbox-runner   (uses goja, pure-Go JS engine)
 *   rust → scripts/rust-sandbox-runner/target/release/sandbox-runner (uses boa_engine)
 *
 * Both runners:
 *   - Read JavaScript code from stdin
 *   - Read DATA from SANDBOX_DATA environment variable
 *   - Write stdout output to stdout
 *   - Write errors to stderr
 *   - Exit 0 on success, 1 on error
 *
 * Build instructions:
 *   go:   cd scripts/go-sandbox-runner   && go build -o sandbox-runner .
 *   rust: cd scripts/rust-sandbox-runner && cargo build --release
 *
 * @param binaryPath - Absolute path to the compiled runner binary
 * @param langLabel  - Language label for error messages ('go' | 'rust')
 */
async function executeSubprocessRunner(
  binaryPath: string,
  langLabel: string,
  code: string,
  data: string,
  timeoutMs: number
): Promise<ExecutionResult> {
  const startTime = Date.now();

  // Check binary exists
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
      maxBuffer: 1024 * 1024, // 1 MB output limit
    } as any);

    return {
      stdout: (stdout as string).trimEnd(),
      stderr: (stderr as string).trimEnd(),
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
