import { describe, it, expect, afterEach } from 'vitest';
import { dispatchBrowserAction } from '../src/browser/dispatch.js';
import { BrowserSession } from '../src/browser/BrowserSession.js';
import { BrowserSessionPool, setBrowserSessionPoolForTesting } from '../src/browser/BrowserSessionPool.js';
import { FakeDevToolsClient } from '../src/browser/DevToolsClient.js';

// A fake page whose interceptor keeps a growing log; evaluate_script runs the drain contract:
// return entries with seq > args.since plus the newest seq as the cursor.
function fakePage() {
    const log: Array<{ seq: number; url: string; method: string; status: number }> = [];
    let seq = 0;
    const capture = (url: string) => { log.push({ seq: ++seq, url, method: 'GET', status: 200 }); };
    const factory = async (id: string) => new BrowserSession(id, new FakeDevToolsClient((req: any) => {
        const fn: string = req.arguments?.function ?? '';
        const m = fn.match(/atob\('([^']*)'\)/);
        const args = m ? JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) : {};
        const since = Number(args.since ?? 0);
        const entries = log.filter(e => e.seq > since);
        const cursor = log.length ? log[log.length - 1].seq : since;
        return { content: [{ type: 'text', text: JSON.stringify({ __bt: 1, ok: true, data: { entries, cursor } }) }] };
    }));
    const pool = new BrowserSessionPool(factory);
    setBrowserSessionPoolForTesting(pool);
    return { capture, pool };
}

afterEach(() => setBrowserSessionPoolForTesting(null));

const list = (sessionId: string) => dispatchBrowserAction({ action: 'network', sessionId, params: { op: 'list' } } as any);
const clear = (sessionId: string) => dispatchBrowserAction({ action: 'network', sessionId, params: { op: 'clear' } } as any);

describe('browser_tool network clear', () => {
    it('drops what was captured before it, keeps what is captured after', async () => {
        const { capture, pool } = fakePage();
        capture('https://example.com/a');
        capture('https://example.com/b');

        const cleared: any = await clear('s-clear');
        expect(cleared.success).toBe(true);

        const afterClear: any = await list('s-clear');
        expect(afterClear.success).toBe(true);
        expect(afterClear.data).toEqual([]);

        capture('https://example.com/c');
        const later: any = await list('s-clear');
        expect(later.data.map((e: any) => e.url)).toEqual(['https://example.com/c']);
        await pool.shutdownAll();
    });

    it('reports how many entries it discarded instead of a bare cleared:true', async () => {
        const { capture, pool } = fakePage();
        capture('https://example.com/a');
        capture('https://example.com/b');
        capture('https://example.com/c');
        const cleared: any = await clear('s-count');
        expect(cleared.data.cleared).toBe(3);
        const again: any = await clear('s-count');
        expect(again.data.cleared).toBe(0);
        await pool.shutdownAll();
    });
});
