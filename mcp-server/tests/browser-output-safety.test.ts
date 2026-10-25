import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { dispatchBrowserAction } from '../src/browser/dispatch.js';
import { BrowserSession } from '../src/browser/BrowserSession.js';
import { BrowserSessionPool, setBrowserSessionPoolForTesting } from '../src/browser/BrowserSessionPool.js';
import { FakeDevToolsClient } from '../src/browser/DevToolsClient.js';
import { safeScreenshotName, safeSessionSegment } from '../src/browser/limits.js';

// B11: screenshot filename, outputDir and sessionId all went straight into file paths (path escape).
// B12: evaluate ran caller JS with no gate, no output cap and no timeout.

const OUT = path.join(process.cwd(), 'data', 'scrapes-b11-test');
const envelope = (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ __bt: 1, ok: true, data }) }] });

function installPool(handler: (req: any) => any = () => ({ content: [{ type: 'text', text: 'ok' }] })) {
    const calls: Array<{ name: string; args: any }> = [];
    let launches = 0;
    const pool = new BrowserSessionPool(async (id: string) => {
        launches++;
        return new BrowserSession(id, new FakeDevToolsClient((req: any) => { calls.push({ name: req.name, args: req.arguments ?? req.args }); return handler(req); }));
    });
    setBrowserSessionPoolForTesting(pool);
    return { calls, launches: () => launches, pool };
}

afterEach(() => {
    setBrowserSessionPoolForTesting(null);
    delete process.env.BROWSER_ALLOW_EVALUATE;
    delete process.env.BROWSER_CALL_TIMEOUT_MS;
});

describe('B11: names that end up in file paths', () => {
    it('safeScreenshotName keeps a plain image name and flattens everything else', () => {
        expect(safeScreenshotName('shot.png', 's', 1)).toBe('shot.png');
        expect(safeScreenshotName('../../evil.png', 's', 1)).toBe('evil.png');
        expect(safeScreenshotName('a/b\\c.jpeg', 's', 1)).toBe('c.jpeg');
        expect(safeScreenshotName('run.sh', 's', 1)).toBe('run.sh.png');
        expect(safeScreenshotName('..', 's', 7)).toBe('screenshot_s_7.png');
        expect(safeScreenshotName('', 's', 7)).toBe('screenshot_s_7.png');
        expect(safeScreenshotName(undefined, 's', 7)).toBe('screenshot_s_7.png');
        expect(safeScreenshotName('x\u0000y.png', 's', 1)).not.toContain('\u0000');
    });

    it('safeSessionSegment is a plain name', () => {
        expect(safeSessionSegment('../../x')).toBe('x');
        expect(safeSessionSegment('a/b c')).toBe('a_b_c');
        expect(safeSessionSegment('')).toBe('session');
        expect(safeSessionSegment('x'.repeat(300)).length).toBeLessThanOrEqual(80);
    });

    it('a screenshot filename cannot leave <outputDir>/screenshots', async () => {
        const { calls, pool } = installPool();
        const r: any = await dispatchBrowserAction({ action: 'screenshot', sessionId: 's-shot', outputDir: OUT, params: { filename: '../../../evil.png' } });
        expect(r.success).toBe(true);
        const filePath = calls.find(c => c.name === 'take_screenshot')!.args.filePath as string;
        expect(path.resolve(filePath)).toBe(path.resolve(OUT, 'screenshots', 'evil.png'));
        await pool.shutdownAll();
    });

    it('a hostile sessionId is made a plain name before it reaches a path', async () => {
        const { calls, pool } = installPool();
        await dispatchBrowserAction({ action: 'screenshot', sessionId: '../../../etc/x', outputDir: OUT, params: {} });
        const filePath = calls.find(c => c.name === 'take_screenshot')!.args.filePath as string;
        expect(path.relative(path.resolve(OUT, 'screenshots'), path.resolve(filePath)).startsWith('..')).toBe(false);
        await pool.shutdownAll();
    });

    it.each([process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc', path.join(process.cwd(), '..', '..', 'outside')])(
        'an outputDir outside the allowed roots is refused before a browser is launched: %s', async (outputDir) => {
            const { launches } = installPool();
            const r: any = await dispatchBrowserAction({ action: 'screenshot', sessionId: 's-out', outputDir, params: {} });
            expect(r.success).toBe(false);
            expect(r.errors[0].code).toBe('OUTPUT_DIR_BLOCKED');
            expect(launches()).toBe(0);
        });
});

describe('B12: evaluate limits', () => {
    const fn = '() => document.title';

    it('can be switched off (BROWSER_ALLOW_EVALUATE=0) before a browser is launched', async () => {
        process.env.BROWSER_ALLOW_EVALUATE = '0';
        const { launches } = installPool();
        const r: any = await dispatchBrowserAction({ action: 'evaluate', sessionId: 's-ev0', params: { function: fn } });
        expect(r.success).toBe(false);
        expect(r.errors[0].code).toBe('EVALUATE_DISABLED');
        expect(launches()).toBe(0);
    });

    it('is on by default', async () => {
        const { pool } = installPool(() => envelope('Example'));
        const r: any = await dispatchBrowserAction({ action: 'evaluate', sessionId: 's-ev1', params: { function: fn } });
        expect(r.success).toBe(true);
        expect(r.data).toBe('Example');
        await pool.shutdownAll();
    });

    it('refuses an oversized function body', async () => {
        const { launches } = installPool();
        const r: any = await dispatchBrowserAction({ action: 'evaluate', sessionId: 's-ev2', params: { function: `() => "${'x'.repeat(30_000)}"` } });
        expect(r.success).toBe(false);
        expect(r.errors[0].code).toBe('INVALID_INPUT');
        expect(launches()).toBe(0);
    });

    it('caps what comes back and says it did', async () => {
        const { pool } = installPool(() => envelope('y'.repeat(500_000)));
        const r: any = await dispatchBrowserAction({ action: 'evaluate', sessionId: 's-ev3', params: { function: fn } });
        expect(r.success).toBe(true);
        expect(JSON.stringify(r.data).length).toBeLessThan(110_000);
        expect(r.data.truncated).toBe(true);
        expect(r.data.originalChars).toBeGreaterThan(500_000);
        await pool.shutdownAll();
    });

    it('times out instead of waiting forever', async () => {
        process.env.BROWSER_CALL_TIMEOUT_MS = '80';
        const { pool } = installPool(() => new Promise(() => {}));
        const started = Date.now();
        const r: any = await dispatchBrowserAction({ action: 'evaluate', sessionId: 's-ev4', params: { function: fn } });
        expect(r.success).toBe(false);
        expect(JSON.stringify(r.errors)).toMatch(/timed out/i);
        expect(Date.now() - started).toBeLessThan(2000);
        await pool.shutdownAll();
    });
});
