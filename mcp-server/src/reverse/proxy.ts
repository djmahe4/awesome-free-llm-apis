import { execSync } from 'node:child_process';

export type ProxyErrorCode =
  | 'not_allowed'
  | 'timeout'
  | 'output_too_large'
  | 'closed'
  | 'protocol_error';

export class ProxyError extends Error {
  public readonly code: ProxyErrorCode;

  constructor(message: string, code: ProxyErrorCode) {
    super(message);
    this.name = 'ProxyError';
    this.code = code;
  }
}

/**
 * Validates CLI arguments for REA execution.
 * Enforces threat model rule: never expose `setup` (rewrites configs) or `--http` (unauthenticated daemon).
 */
export function reaMcpArgs(reaPath: string, extraArgs: string[] = []): string[] {
  for (const arg of extraArgs) {
    if (arg === 'setup' || arg === '--http' || arg.includes('setup') || arg.includes('--http')) {
      throw new Error(`Forbidden REA argument: ${arg}`);
    }
  }
  return [reaPath, 'mcp', ...extraArgs];
}

/**
 * Forcefully terminates a process and all its child descendants cross-platform.
 * On Windows: taskkill /pid <PID> /T /F
 * On POSIX: SIGKILL to process group or PID
 */
export function treeKill(pid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (!pid || pid <= 0) return;

  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } catch {
      // Ignore if process already exited or sandbox denies RPC
    }
    try {
      process.kill(pid, signal);
    } catch {
      // Ignore if already dead
    }
  } else {
    try {
      // Try killing process group first if detached
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // Ignore if already dead
      }
    }
  }
}
