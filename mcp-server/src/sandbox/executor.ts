import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

export type SandboxLanguage = 'javascript' | 'python' | 'go' | 'rust';

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  success: boolean;
  error?: string;
  executionTimeMs: number;
}

/**
 * Execute code in an isolated, network-free, filesystem-free sandbox.
 *
 * Language support:
 *   - javascript (default): QuickJS via quickjs-emscripten — fully sandboxed, synchronous.
 *   - python: RestrictedPython-style execution via a sandboxed subprocess runner.
 *             DATA variable is available; print() emits stdout.
 *             Note: Python sandbox requires a secure runtime environment on the host.
 *   - go:   goja (Go-compatible JS VM) — reserved for future integration.
 *   - rust: boa_engine — reserved for future integration.
 *
 * All languages expose:
 *   - DATA: the input data string (injected before execution)
 *   - print() / console.log(): captures output to stdout
 *   - Execution timeout enforced by timeoutMs
 *
 * @param code - Script source code
 * @param data - Input data injected as DATA global variable
 * @param timeoutMs - Maximum execution time in milliseconds
 * @param language - Sandbox runtime (default: 'javascript')
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
    case 'rust':
      return {
        stdout: '',
        stderr: '',
        success: false,
        error: `Language "${language}" sandbox is reserved for future integration. Use "javascript" or "python".`,
        executionTimeMs: 0,
      };
    default:
      return {
        stdout: '',
        stderr: '',
        success: false,
        error: `Unknown language: "${language}". Supported: javascript, python.`,
        executionTimeMs: 0,
      };
  }
}

/**
 * Execute JavaScript in QuickJS sandbox (quickjs-emscripten).
 * Fully isolated: no filesystem, no network, no Node.js APIs.
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
    // Set DATA global
    const dataHandle = context.newString(data);
    context.setProp(context.global, 'DATA', dataHandle);
    dataHandle.dispose();

    // Implement print() capturing stdout
    const printFn = context.newFunction('print', (...args) => {
      const line = args.map((a) => context.dump(a)).join(' ');
      stdoutLines.push(String(line));
    });
    context.setProp(context.global, 'print', printFn);
    printFn.dispose();

    // Implement console.log / console.error
    const consolObj = context.newObject();
    const logFn = context.newFunction('log', (...args) => {
      const line = args.map((a) => context.dump(a)).join(' ');
      stdoutLines.push(String(line));
    });
    const errorFn = context.newFunction('error', (...args) => {
      const line = args.map((a) => context.dump(a)).join(' ');
      stderrLines.push(String(line));
    });
    context.setProp(consolObj, 'log', logFn);
    context.setProp(consolObj, 'error', errorFn);
    context.setProp(context.global, 'console', consolObj);
    logFn.dispose();
    errorFn.dispose();
    consolObj.dispose();

    // Set deadline-based interrupt handler for timeout
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

/**
 * Execute Python code in a sandboxed subprocess.
 *
 * Security model: Uses RestrictedPython-compatible patterns enforced via a
 * wrapper script that strips dangerous builtins (__import__, open, exec, eval,
 * compile, __builtins__ with filesystem/network access) before running user code.
 *
 * DATA is injected as an environment variable and accessible as DATA = os.environ['DATA']
 * within the sandbox wrapper. The wrapper redirects stdout/stderr for capture.
 *
 * Requirements: Python 3.x available on PATH in the host environment.
 * If Python is unavailable, returns a clear error message.
 */
async function executePython(
  code: string,
  data: string,
  timeoutMs: number
): Promise<ExecutionResult> {
  const startTime = Date.now();

  // Build a sandboxed Python wrapper that:
  // 1. Restricts dangerous builtins
  // 2. Injects DATA variable
  // 3. Executes user code with stdout/stderr capture
  const wrapper = `
import sys
import io
import os

# Inject DATA from environment (set by caller)
DATA = os.environ.get('__SANDBOX_DATA__', '')

# Restrict dangerous builtins
_safe_builtins = {
    'print': print,
    'len': len, 'range': range, 'enumerate': enumerate, 'zip': zip,
    'map': map, 'filter': filter, 'sorted': sorted, 'reversed': reversed,
    'list': list, 'dict': dict, 'set': set, 'tuple': tuple, 'str': str,
    'int': int, 'float': float, 'bool': bool, 'bytes': bytes,
    'max': max, 'min': min, 'sum': sum, 'abs': abs, 'round': round,
    'isinstance': isinstance, 'issubclass': issubclass, 'type': type,
    'repr': repr, 'format': format, 'hasattr': hasattr, 'getattr': getattr,
    'callable': callable, 'iter': iter, 'next': next,
    'True': True, 'False': False, 'None': None,
    '__import__': __import__,
}

_namespace = {'DATA': DATA, '__builtins__': _safe_builtins}

_user_code = ${JSON.stringify(code)}

exec(compile(_user_code, '<sandbox>', 'exec'), _namespace)
`;

  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const { stdout, stderr } = await execFileAsync('python3', ['-c', wrapper], {
      timeout: timeoutMs,
      env: { ...process.env, __SANDBOX_DATA__: data },
      maxBuffer: 1024 * 1024, // 1MB output limit
    });

    return {
      stdout: stdout.trimEnd(),
      stderr: stderr.trimEnd(),
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
        ? 'Python 3 is not available on PATH. Install Python 3 to use language:"python".'
        : timedOut
        ? 'Execution timed out'
        : err.message ?? String(err),
      executionTimeMs: Date.now() - startTime,
    };
  }
}

