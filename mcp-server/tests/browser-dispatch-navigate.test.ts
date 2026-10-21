import { describe, it, expect, afterEach } from 'vitest';
import { dispatchBrowserAction } from '../src/browser/dispatch.js';
import { parseInput } from '../src/browser/actionSchemas.js';
import { BrowserSession } from '../src/browser/BrowserSession.js';
import { BrowserSessionPool, setBrowserSessionPoolForTesting } from '../src/browser/BrowserSessionPool.js';
import { FakeDevToolsClient } from '../src/browser/DevToolsClient.js';

// Real dispatcher + real parseInput; only the Chrome DevTools transport is faked.
// (The harness scraper-step test mocks dispatch itself, so it never exercised this path.)
function installFakePool() {
    const calls: Array<{ name: string; args: any }> = [];
    const factory = async (id: string) => new BrowserSession(id, new FakeDevToolsClient((req: any) => {
        calls.push({ name: req.name, args: req.arguments ?? req.args });
        return { content: [{ type: 'text', text: 'ok' }] };
    }));
    const pool = new BrowserSessionPool(factory);
    setBrowserSessionPoolForTesting(pool);
    return { calls, pool };
}

afterEach(() => setBrowserSessionPoolForTesting(null));

const navigated = (calls: Array<{ name: string; args: any }>) => calls.filter(c => c.name === 'navigate_page');

describe('browser_tool navigate: url may be top-level or in params', () => {
    it('top-level url only (what the harness scraper step sends)', async () => {
        const { calls, pool } = installFakePool();
        const r = await dispatchBrowserAction({ action: 'navigate', url: 'https://example.com/a', sessionId: 's-top' });
        expect(r.success).toBe(true);
        expect(navigated(calls)[0].args.url).toBe('https://example.com/a');
        await pool.shutdownAll();
    });

    it('params.url only (what an MCP caller following the schema sends)', async () => {
        const { calls, pool } = installFakePool();
        const r = await dispatchBrowserAction({ action: 'navigate', sessionId: 's-params', params: { url: 'https://example.com/b' } });
        expect(r.success).toBe(true);
        expect(navigated(calls)[0].args.url).toBe('https://example.com/b');
        await pool.shutdownAll();
    });

    it('both: params.url wins, nothing throws', async () => {
        const { calls, pool } = installFakePool();
        const r = await dispatchBrowserAction({ action: 'navigate', url: 'https://example.com/top', sessionId: 's-both', params: { url: 'https://example.com/params' } });
        expect(r.success).toBe(true);
        expect(navigated(calls)[0].args.url).toBe('https://example.com/params');
        await pool.shutdownAll();
    });

    it('neither: a clear MISSING_URL error, not a raw validation exception', async () => {
        const { pool } = installFakePool();
        const r = await dispatchBrowserAction({ action: 'navigate', sessionId: 's-none' });
        expect(r.success).toBe(false);
        expect(JSON.stringify(r.errors)).toContain('MISSING_URL');
        await pool.shutdownAll();
    });
});

describe('parseInput', () => {
    it('does not throw for navigate with only a top-level url', () => {
        expect(() => parseInput({ action: 'navigate', url: 'https://example.com' })).not.toThrow();
    });
});
