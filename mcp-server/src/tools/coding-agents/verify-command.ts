import { spawn, spawnSync } from 'node:child_process';

/**
 * Behavioural gate for coding_agents: a caller-supplied check (normally a test run) that must still
 * pass after an edit. A compiler can say the code is well-formed; only a check can say it is right
 * (a model-written isPrivateIPv4 compiled cleanly, was applied, and was wrong in four places).
 *
 * The command comes from a tool call, so it is validated hard and never goes through a shell
 * interpreter: only known runners, no shell metacharacters or quotes, no inline-code flags.
 */

const ALLOWED_EXECUTABLES = new Set([
  'npx', 'npm', 'pnpm', 'yarn', 'node', 'pytest', 'python', 'python3', 'go', 'cargo', 'dotnet', 'mvn', 'gradle', 'make',
]);
const INLINE_CODE_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c', '--command', '--exec']);
const SHELL_CHARS = /[;&|<>`$(){}\\\n\r"'*?~!#]/;

export type VerifyValidation = { ok: true; exe: string; args: string[] } | { ok: false; reason: string };

export function validateVerifyCommand(command: string): VerifyValidation {
  const text = String(command ?? '').trim();
  if (!text) return { ok: false, reason: 'verifyCommand is empty' };
  if (text.length > 300) return { ok: false, reason: 'verifyCommand is longer than 300 characters' };
  if (SHELL_CHARS.test(text)) return { ok: false, reason: 'verifyCommand may not contain shell metacharacters or quotes' };
  const [exe, ...args] = text.split(/\s+/);
  if (!ALLOWED_EXECUTABLES.has(exe)) {
    return { ok: false, reason: `verifyCommand must start with one of: ${[...ALLOWED_EXECUTABLES].join(', ')}` };
  }
  const flag = args.find(a => INLINE_CODE_FLAGS.has(a));
  if (flag) return { ok: false, reason: `inline-code flag ${flag} is not allowed in verifyCommand; point it at a script or test file` };
  return { ok: true, exe, args };
}

export interface VerifyRunResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** Last ~4 KB of combined stdout+stderr, enough to see the failing assertion. */
  outputTail: string;
  /** Names of failing cases collected across the WHOLE output (the tail only holds the last few). */
  failedCases: string[];
  durationMs: number;
  /** The command failed validation and nothing was run. */
  rejected?: boolean;
  reason?: string;
}

const TAIL_BYTES = 4096;
const MAX_FAILED_CASES = 200;

/** Failing-case name from one output line (node:test, vitest/jest, pytest, TAP), or null. */
export function failedCaseName(line: string): string | null {
  const t = line.trim();
  let m = t.match(/^[\u2716\u00d7\u2717x]\s+(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?$/);
  if (m && !/^failing tests:?$/i.test(m[1]) && !/^\d+ failed/i.test(m[1])) return m[1];
  m = t.match(/^FAILED\s+(.+)$/);
  if (m) return m[1];
  m = t.match(/^FAIL\s+(.+)$/);
  if (m) return m[1];
  m = t.match(/^not ok\s+\d+\s*-?\s*(.+)$/);
  if (m) return m[1];
  return null;
}
const DEFAULT_TIMEOUT_MS = 120_000;

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
}

export async function runVerifyCommand(
  command: string,
  cwd: string,
  opts: { timeoutMs?: number } = {},
): Promise<VerifyRunResult> {
  const v = validateVerifyCommand(command);
  if (!v.ok) return { ok: false, exitCode: null, timedOut: false, outputTail: '', failedCases: [], durationMs: 0, rejected: true, reason: v.reason };

  const timeoutMs = opts.timeoutMs ?? (parseInt(process.env.CODING_AGENTS_VERIFY_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS);
  const started = Date.now();
  // npm/npx/pnpm/yarn are .cmd shims on Windows, which spawn cannot run without a shell. The command
  // was validated above (no metacharacters, quotes or substitutions), so cmd.exe only ever sees
  // plain words.
  const useCmd = process.platform === 'win32' && /^(npx|npm|pnpm|yarn)$/.test(v.exe);
  const [file, args] = useCmd ? ['cmd.exe', ['/d', '/s', '/c', v.exe, ...v.args]] : [v.exe, v.args];

  return new Promise<VerifyRunResult>(resolve => {
    let tail = '';
    let pending = '';
    const failed: string[] = [];
    const seen = new Set<string>();
    let timedOut = false;
    const child = spawn(file, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    });
    const append = (d: Buffer) => {
      const text = d.toString();
      tail = (tail + text).slice(-TAIL_BYTES);
      // Scan every complete line as it streams: the tail alone only holds the last few failures.
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      if (pending.length > 2000) pending = '';
      for (const l of lines) {
        const name = failedCaseName(l);
        if (name && !seen.has(name) && failed.length < MAX_FAILED_CASES) { seen.add(name); failed.push(name); }
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    const finish = (exitCode: number | null, extra = '') => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && exitCode === 0,
        exitCode,
        timedOut,
        outputTail: (tail + extra).slice(-TAIL_BYTES),
        failedCases: failed,
        durationMs: Date.now() - started,
      });
    };
    child.on('error', err => finish(null, `\n[spawn error] ${err.message}`));
    child.on('close', code => finish(code));
  });
}
