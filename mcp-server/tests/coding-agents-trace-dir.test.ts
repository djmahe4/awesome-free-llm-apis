import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { caTraceDump, caTraceDir } from '../src/tools/coding-agents/trace.js';

// With the timing trace on, rejected model replies are saved too, so a failed run can be read afterwards
// without a second run that has the extra variable set.

describe('reply tracing', () => {
    let dir: string;
    const saved = { trace: process.env.CODING_AGENTS_TRACE, dir: process.env.CODING_AGENTS_TRACE_DIR };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-trace-'));
        delete process.env.CODING_AGENTS_TRACE;
        delete process.env.CODING_AGENTS_TRACE_DIR;
    });
    afterEach(() => {
        for (const [k, v] of [['CODING_AGENTS_TRACE', saved.trace], ['CODING_AGENTS_TRACE_DIR', saved.dir]] as const) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('is off by default', () => {
        expect(caTraceDir()).toBeUndefined();
        caTraceDump('reply', 'text');
    });
    it('an explicit directory is used as given', () => {
        process.env.CODING_AGENTS_TRACE_DIR = dir;
        expect(caTraceDir()).toBe(dir);
        caTraceDump('reply a', 'hello');
        const files = fs.readdirSync(dir);
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/reply_a\.txt$/);
        expect(fs.readFileSync(path.join(dir, files[0]), 'utf8')).toBe('hello');
    });
    it('the timing trace alone saves replies under .free-llm-mcp/ca-traces in the working directory', () => {
        process.env.CODING_AGENTS_TRACE = '1';
        const dirName = caTraceDir();
        expect(dirName).toBe(path.join(process.cwd(), '.free-llm-mcp', 'ca-traces'));
    });
    it('an explicit directory wins over the default', () => {
        process.env.CODING_AGENTS_TRACE = '1';
        process.env.CODING_AGENTS_TRACE_DIR = dir;
        expect(caTraceDir()).toBe(dir);
    });
});
