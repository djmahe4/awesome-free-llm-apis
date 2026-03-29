import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  success: boolean;
  error?: string;
  executionTimeMs: number;
}

export async function executeInSandbox(
  code: string,
  data: string = '',
  timeoutMs: number = 5000
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
