import { describe, it, expect, afterEach } from 'vitest';
import { dispatchBrowserAction } from '../src/browser/dispatch.js';
import { BrowserSession } from '../src/browser/BrowserSession.js';
import { BrowserSessionPool, setBrowserSessionPoolForTesting } from '../src/browser/BrowserSessionPool.js';
import { FakeDevToolsClient } from '../src/browser/DevToolsClient.js';
import { findUnsupportedOptions } from '../src/browser/unsupported.js';

// The schema advertises options the handlers never read. They used to be accepted, ignored, and the
// failure (if any) came late, after Chrome had been launched. Now they are refused up front.
function installCountingPool() {
    let launches = 0;
    const pool = new BrowserSessionPool(async (id: string) => {
        launches++;
        return new BrowserSession(id, new FakeDevToolsClient(() => ({ content: [{ type: 'text', text: 'ok' }] })));
    });
    setBrowserSessionPoolForTesting(pool);
    return { launches: () => launches, pool };
}
afterEach(() => setBrowserSessionPoolForTesting(null));

const cases: Array<[string, any]> = [
    ['navigate waitFor', { action: 'navigate', params: { url: 'https://example.com', waitFor: { until: 'timeout' } } }],
    ['snapshot includeState', { action: 'snapshot', params: { includeState: true } }],
    ['click index', { action: 'click', params: { by: 'text', value: 'Go', index: 2 } }],
    ['scroll steps', { action: 'scroll', params: { target: 'window', steps: 3 } }],
    ['wait until depth', { action: 'wait', params: { until: 'depth' } }],
    ['network op get', { action: 'network', params: { op: 'get' } }],
    ['network withBodies', { action: 'network', params: { op: 'list', withBodies: true } }],
    ['api_replay endpoints', { action: 'api_replay', params: { endpoints: ['https://example.com/a'] } }],
    ['extract script strategy', { action: 'extract', params: { strategy: 'script', script: 'x' } }],
    ['deep_scrape linkFilter', { action: 'deep_scrape', params: { linkFilter: 'a' } }],
    ['screenshot selector', { action: 'screenshot', params: { selectorOrLabel: '#x' } }],
    ['checkpoint delete', { action: 'checkpoint', params: { op: 'delete' } }],
    ['site_memory', { action: 'site_memory', params: { op: 'read' } }],
];

describe('browser_tool refuses options it does not implement, before launching Chrome', () => {
    it.each(cases)('%s', async (_name, input) => {
        const { launches } = installCountingPool();
        const r: any = await dispatchBrowserAction({ ...input, sessionId: 's-unsupported' });
        expect(r.success).toBe(false);
        expect(r.errors[0].code).toBe('UNSUPPORTED_OPTION');
        expect(r.errors[0].message).toMatch(/not supported|not implemented/i);
        expect(launches()).toBe(0);
    });

    it('names every offending option in one message', () => {
        const found = findUnsupportedOptions({ action: 'snapshot', params: { includeState: true, includeDepth: true, verbose: true } } as any);
        expect(found.sort()).toEqual(['includeDepth', 'includeState']);
    });

    it('supported options pass through untouched', () => {
        expect(findUnsupportedOptions({ action: 'navigate', params: { url: 'https://example.com' } } as any)).toEqual([]);
        expect(findUnsupportedOptions({ action: 'network', params: { op: 'list', limit: 5 } } as any)).toEqual([]);
        expect(findUnsupportedOptions({ action: 'wait', params: { until: 'dom-stable', timeoutMs: 100 } } as any)).toEqual([]);
        expect(findUnsupportedOptions({ action: 'extract', params: { strategy: 'auto' } } as any)).toEqual([]);
    });

    it('an unset option (undefined) is not an offence', () => {
        expect(findUnsupportedOptions({ action: 'snapshot', params: { includeState: undefined } } as any)).toEqual([]);
    });
});
