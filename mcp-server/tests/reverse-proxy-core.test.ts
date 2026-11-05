import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { ProxyError, reaMcpArgs, treeKill } from '../src/reverse/proxy.js';

describe('ProxyError', () => {
  it('instantiates with custom code and message', () => {
    const err = new ProxyError('Operation timed out', 'timeout');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ProxyError');
    expect(err.code).toBe('timeout');
    expect(err.message).toBe('Operation timed out');
  });

  it('supports all required error codes', () => {
    const codes = ['not_allowed', 'timeout', 'output_too_large', 'closed', 'protocol_error'] as const;
    for (const code of codes) {
      const err = new ProxyError(`Error ${code}`, code);
      expect(err.code).toBe(code);
    }
  });
});

describe('reaMcpArgs', () => {
  it('constructs basic mcp argument array', () => {
    const args = reaMcpArgs('/usr/local/bin/rea');
    expect(args).toEqual(['/usr/local/bin/rea', 'mcp']);
  });

  it('allows benign flags', () => {
    const args = reaMcpArgs('/usr/local/bin/rea', ['--json']);
    expect(args).toEqual(['/usr/local/bin/rea', 'mcp', '--json']);
  });

  it('refuses setup commands', () => {
    expect(() => reaMcpArgs('/usr/local/bin/rea', ['setup'])).toThrow(/Forbidden REA argument/);
    expect(() => reaMcpArgs('/usr/local/bin/rea', ['rea_setup'])).toThrow(/Forbidden REA argument/);
  });

  it('refuses --http network daemon exposure', () => {
    expect(() => reaMcpArgs('/usr/local/bin/rea', ['--http'])).toThrow(/Forbidden REA argument/);
    expect(() => reaMcpArgs('/usr/local/bin/rea', ['mcp', '--http'])).toThrow(/Forbidden REA argument/);
  });
});

describe('treeKill', () => {
  it('terminates a spawned process and its tree cleanly', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    });
    expect(child.pid).toBeDefined();
    const pid = child.pid!;

    const isAlive = (p: number) => {
      try {
        process.kill(p, 0);
        return true;
      } catch {
        return false;
      }
    };

    expect(isAlive(pid)).toBe(true);
    treeKill(pid);
    await new Promise((r) => setTimeout(r, 400));
    expect(isAlive(pid)).toBe(false);
  });
});
