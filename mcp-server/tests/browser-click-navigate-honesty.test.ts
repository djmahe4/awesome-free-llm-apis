import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { dispatchBrowserAction } from '../src/browser/dispatch.js';
import { BrowserSession } from '../src/browser/BrowserSession.js';
import { BrowserSessionPool, setBrowserSessionPoolForTesting } from '../src/browser/BrowserSessionPool.js';
import { FakeDevToolsClient } from '../src/browser/DevToolsClient.js';
import { setBrowserUrlResolverForTesting } from '../src/browser/urlGuard.js';

// B4: click by:'uid' indexed a list the code built itself, not the uid from the snapshot, so it clicked the
//     wrong element and reported success.
// B3: navigate reported success on a Cloudflare / captcha wall.

const SNAPSHOT_OK = 'RootWebArea "Shop"\n  uid=1_0 link "Home"\n  uid=1_5 button "Add to cart"';
const SNAPSHOT_WALL = 'heading "Just a moment..."\ntext "Checking your browser before accessing example.com"';

function installPool(handler: (req: any) => any) {
    const calls: Array<{ name: string; args: any }> = [];
    const pool = new BrowserSessionPool(async (id: string) =>
        new BrowserSession(id, new FakeDevToolsClient((req: any) => { calls.push({ name: req.name, args: req.arguments ?? req.args }); return handler(req); })));
    setBrowserSessionPoolForTesting(pool);
    return { calls, pool };
}
const text = (t: string) => ({ content: [{ type: 'text', text: t }] });

beforeEach(() => { process.env.BROWSER_ALLOW_PRIVATE = '0'; setBrowserUrlResolverForTesting(async () => ['93.184.216.34']); });
afterEach(() => { setBrowserSessionPoolForTesting(null); setBrowserUrlResolverForTesting(null); delete process.env.BROWSER_ALLOW_PRIVATE; });

describe('B4: click by uid uses the snapshot uid', () => {
    it("clicks through the DevTools click tool with that uid, not by an index into a guessed element list", async () => {
        const { calls, pool } = installPool(req => (req.name === 'take_snapshot' ? text(SNAPSHOT_OK) : text('clicked')));
        const r: any = await dispatchBrowserAction({ action: 'click', sessionId: 's-uid', params: { by: 'uid', value: '1_5' } });
        expect(r.success).toBe(true);
        const click = calls.find(c => c.name === 'click');
        expect(click?.args).toMatchObject({ uid: '1_5' });
        expect(calls.some(c => c.name === 'evaluate_script' && /nodes\[parseInt/.test(String(c.args?.function)))).toBe(false);
        await pool.shutdownAll();
    });

    it('an unknown uid is ELEMENT_NOT_FOUND, not a success', async () => {
        const { pool } = installPool(req => (req.name === 'click' ? { isError: true, content: [{ type: 'text', text: 'No element found with uid 9_9' }] } : text(SNAPSHOT_OK)));
        const r: any = await dispatchBrowserAction({ action: 'click', sessionId: 's-uid2', params: { by: 'uid', value: '9_9' } });
        expect(r.success).toBe(false);
        expect(r.errors[0].code).toBe('ELEMENT_NOT_FOUND');
        expect(r.errors[0].message).toMatch(/uid 9_9/);
        await pool.shutdownAll();
    });

    it('a uid with spaces or quotes is refused before anything is clicked', async () => {
        const { calls, pool } = installPool(() => text(SNAPSHOT_OK));
        const r: any = await dispatchBrowserAction({ action: 'click', sessionId: 's-uid3', params: { by: 'uid', value: '1_5"; drop' } });
        expect(r.success).toBe(false);
        expect(calls.some(c => c.name === 'click')).toBe(false);
        await pool.shutdownAll();
    });
});

describe('B3: navigate does not hide a challenge wall', () => {
    it('reports BLOCKED_BY_CLOUDFLARE and data.blocked on a Cloudflare interstitial', async () => {
        const { pool } = installPool(req => (req.name === 'take_snapshot' ? text(SNAPSHOT_WALL) : text('ok')));
        const r: any = await dispatchBrowserAction({ action: 'navigate', sessionId: 's-nav1', url: 'https://example.com/' });
        expect(r.data.blocked).toBe(true);
        expect(r.warnings).toContain('BLOCKED_BY_CLOUDFLARE');
        await pool.shutdownAll();
    });

    it('a normal page is not flagged', async () => {
        const { pool } = installPool(req => (req.name === 'take_snapshot' ? text(SNAPSHOT_OK) : text('ok')));
        const r: any = await dispatchBrowserAction({ action: 'navigate', sessionId: 's-nav2', url: 'https://example.com/' });
        expect(r.success).toBe(true);
        expect(r.data.blocked).toBeFalsy();
        expect(r.warnings ?? []).toEqual([]);
        await pool.shutdownAll();
    });

    it('a snapshot failure after a good navigation does not fail the navigation', async () => {
        const { pool } = installPool(req => { if (req.name === 'take_snapshot') throw new Error('Invalid params'); return text('ok'); });
        const r: any = await dispatchBrowserAction({ action: 'navigate', sessionId: 's-nav3', url: 'https://example.com/' });
        expect(r.success).toBe(true);
        expect(r.data.navigated).toBe(true);
        await pool.shutdownAll();
    });
});
