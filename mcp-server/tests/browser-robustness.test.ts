import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { BrowserSession } from '../src/browser/BrowserSession.js';
import { BrowserSessionPool } from '../src/browser/BrowserSessionPool.js';
import { FakeDevToolsClient } from '../src/browser/DevToolsClient.js';
import { boundedMs, isTransientError } from '../src/browser/limits.js';
import { installShutdownHooks } from '../src/utils/shutdown-hooks.js';

// B8: a hung Chrome call blocked forever and every error was retried, including non-transient ones, with
//     caller-supplied timeouts unbounded. B9: two simultaneous acquires of one session id launched two
//     Chromes on one profile (one orphaned). B10: the stdio server did not close Chrome when its parent went
//     away (stdin closed), only on SIGINT/SIGTERM.

afterEach(() => { delete process.env.BROWSER_CALL_TIMEOUT_MS; vi.restoreAllMocks(); });

describe('B8: call timeout and retry policy', () => {
    it('a call that never answers times out (BROWSER_CALL_TIMEOUT_MS) and is not retried', async () => {
        process.env.BROWSER_CALL_TIMEOUT_MS = '60';
        let calls = 0;
        const client = { callTool: () => { calls++; return new Promise(() => {}); }, close: async () => {} };
        const s = new BrowserSession('t', client as any);
        const started = Date.now();
        await expect(s.call('take_snapshot')).rejects.toThrow(/timed out after 60ms/i);
        expect(Date.now() - started).toBeLessThan(1500);
        expect(calls).toBe(1);
    });

    it('a transport error is retried, a non-transient one is not', async () => {
        let transient = 0, permanent = 0;
        const s1 = new BrowserSession('a', { callTool: async () => { transient++; throw new Error('read ECONNRESET'); }, close: async () => {} } as any);
        await expect(s1.call('x', {}, { retries: 2 })).rejects.toThrow(/ECONNRESET/);
        expect(transient).toBe(2);
        const s2 = new BrowserSession('b', { callTool: async () => { permanent++; throw new Error('MCP error -32602: Invalid params'); }, close: async () => {} } as any);
        await expect(s2.call('x', {}, { retries: 3 })).rejects.toThrow(/Invalid params/);
        expect(permanent).toBe(1);
    });

    it('isTransientError / boundedMs', () => {
        expect(isTransientError(new Error('socket hang up'))).toBe(true);
        expect(isTransientError(new Error('Connection closed'))).toBe(true);
        expect(isTransientError(new Error('Invalid params'))).toBe(false);
        expect(isTransientError(Object.assign(new Error('timed out after 60ms'), { name: 'BrowserCallTimeout' }))).toBe(false);
        expect(boundedMs(1e12, 0, 300_000, 8000)).toBe(300_000);
        expect(boundedMs(-5, 0, 300_000, 8000)).toBe(0);
        expect(boundedMs(NaN, 0, 300_000, 8000)).toBe(8000);
        expect(boundedMs('12' as any, 0, 300_000, 8000)).toBe(8000);
        expect(boundedMs(2500, 0, 300_000, 8000)).toBe(2500);
    });
});

describe('B9: one launch per session id', () => {
    it('simultaneous acquires share one launch', async () => {
        let launches = 0;
        const pool = new BrowserSessionPool(async (id: string) => {
            launches++;
            await new Promise(r => setTimeout(r, 40));
            return new BrowserSession(id, new FakeDevToolsClient());
        });
        const [a, b, c] = await Promise.all([pool.acquire('same'), pool.acquire('same'), pool.acquire('same')]);
        expect(launches).toBe(1);
        expect(a.session).toBe(b.session);
        expect(b.session).toBe(c.session);
        expect(pool.size()).toBe(1);
        await pool.shutdownAll();
    });

    it('a failed launch is shared by the waiters and does not leave a stuck in-flight entry', async () => {
        let launches = 0;
        const pool = new BrowserSessionPool(async () => { launches++; await new Promise(r => setTimeout(r, 20)); throw new Error('no chrome'); });
        const [a, b] = await Promise.all([pool.acquire('x'), pool.acquire('x')]);
        expect(a.session).toBeNull();
        expect(b.error).toMatch(/no chrome/);
        expect(launches).toBe(1);
        await pool.shutdownAll();
    });

    it('different ids launch independently', async () => {
        let launches = 0;
        const pool = new BrowserSessionPool(async (id: string) => { launches++; return new BrowserSession(id, new FakeDevToolsClient()); });
        await Promise.all([pool.acquire('p'), pool.acquire('q')]);
        expect(launches).toBe(2);
        await pool.shutdownAll();
    });
});

describe('B10: shutdown hooks', () => {
    it('runs once on SIGINT, SIGTERM or the parent closing stdin', async () => {
        for (const trigger of [(p: any) => p.emit('SIGINT'), (p: any) => p.emit('SIGTERM'), (p: any) => p.stdin.emit('end'), (p: any) => p.stdin.emit('close')]) {
            const proc: any = new EventEmitter();
            proc.stdin = new EventEmitter();
            const onShutdown = vi.fn().mockResolvedValue(undefined);
            installShutdownHooks(onShutdown, proc);
            trigger(proc);
            trigger(proc);
            await new Promise(r => setTimeout(r, 10));
            expect(onShutdown).toHaveBeenCalledTimes(1);
        }
    });

    it('a failing shutdown handler does not throw out of the signal handler', async () => {
        const proc: any = new EventEmitter();
        proc.stdin = new EventEmitter();
        installShutdownHooks(vi.fn().mockRejectedValue(new Error('boom')), proc);
        expect(() => proc.emit('SIGTERM')).not.toThrow();
        await new Promise(r => setTimeout(r, 10));
    });
});
