import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Audit P2: runRustcCheck called require('fs') inside an ES module. require does not exist there, the
// ReferenceError was swallowed and every Rust edit was reported clean, even with rustc installed. It
// also wrote its temp file next to the user's source.

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

describe('runRustcCheck', () => {
    it('hands rustc a temp file in the OS temp dir (never next to the source) and removes it afterwards', async () => {
        const seen: string[] = [];
        vi.doMock('node:child_process', async (orig) => {
            const real: any = await orig();
            return {
                ...real,
                spawnSync: (cmd: string, args: string[], opts: any) => {
                    if (cmd !== 'rustc') return real.spawnSync(cmd, args, opts);
                    const file = args[args.length - 1];
                    seen.push(file);
                    expect(fs.existsSync(file)).toBe(true);
                    return { status: 1, stderr: JSON.stringify({ $message_type: 'diagnostic', level: 'error', message: 'expected one of `)`', spans: [{ line_start: 1, column_start: 9 }] }) + '\n', stdout: '' };
                },
            };
        });
        const { runRustcCheck } = await import('../src/tools/coding-agents/diagnostics.js');
        const src = path.join(os.tmpdir(), 'not-here', 'src', 'main.rs');
        const diags = runRustcCheck(src, 'fn main( {');
        expect(diags).toEqual([expect.objectContaining({ severity: 'error', line: 1, message: expect.stringContaining('expected one of') })]);
        expect(seen).toHaveLength(1);
        expect(path.dirname(seen[0])).toBe(os.tmpdir());
        expect(fs.existsSync(seen[0])).toBe(false);
    });

    it('with a real rustc, a syntax error is reported (skipped when rustc is not installed)', async () => {
        if (spawnSync('rustc', ['--version']).status !== 0) return;
        const { runRustcCheck } = await import('../src/tools/coding-agents/diagnostics.js');
        expect(runRustcCheck('main.rs', 'fn main( {').some(d => d.severity === 'error')).toBe(true);
    });
});
