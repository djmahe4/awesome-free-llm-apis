import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { dispatchBrowserAction } from '../src/browser/dispatch.js';
import { parseInput } from '../src/browser/actionSchemas.js';
import { BrowserSession } from '../src/browser/BrowserSession.js';
import { BrowserSessionPool, setBrowserSessionPoolForTesting } from '../src/browser/BrowserSessionPool.js';
import { FakeDevToolsClient } from '../src/browser/DevToolsClient.js';
import { setBrowserUrlResolverForTesting } from '../src/browser/urlGuard.js';

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

// No real DNS in tests: example.com is public, everything else unknown unless a test says otherwise.
beforeEach(() => setBrowserUrlResolverForTesting(async (h: string) => (h === 'example.com' ? ['93.184.216.34'] : h === 'rebind.test' ? ['10.0.0.9'] : [])));
afterEach(() => { setBrowserSessionPoolForTesting(null); setBrowserUrlResolverForTesting(null); delete process.env.BROWSER_ALLOW_PRIVATE; });

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

describe('browser_tool navigate: URL guard', () => {
    it.each([
        'file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'http://127.0.0.1:3000/', 'http://localhost/',
        'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://2130706433/', 'http://rebind.test/',
    ])('refuses %s before any browser is launched', async (url) => {
        const { calls, pool } = installFakePool();
        const r = await dispatchBrowserAction({ action: 'navigate', url, sessionId: 's-guard' });
        expect(r.success).toBe(false);
        expect(JSON.stringify(r.errors)).toMatch(/URL_BLOCKED/);
        expect(calls).toHaveLength(0);
        await pool.shutdownAll();
    });

    it('BROWSER_ALLOW_PRIVATE=1 permits a private target but never a file: URL', async () => {
        process.env.BROWSER_ALLOW_PRIVATE = '1';
        const { calls, pool } = installFakePool();
        const ok = await dispatchBrowserAction({ action: 'navigate', url: 'http://127.0.0.1:3000/', sessionId: 's-priv' });
        expect(ok.success).toBe(true);
        const bad = await dispatchBrowserAction({ action: 'navigate', url: 'file:///etc/passwd', sessionId: 's-priv2' });
        expect(bad.success).toBe(false);
        expect(calls.filter(c => c.name === 'navigate_page')).toHaveLength(1);
        await pool.shutdownAll();
    });

    it('the scrape macro (url + extract) is guarded too', async () => {
        const { calls, pool } = installFakePool();
        const r = await dispatchBrowserAction({ action: 'scrape', url: 'http://10.0.0.1/admin', sessionId: 's-scrape' });
        expect(r.success).toBe(false);
        expect(calls.filter(c => c.name === 'navigate_page')).toHaveLength(0);
        await pool.shutdownAll();
    });
});
