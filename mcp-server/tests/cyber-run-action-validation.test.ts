import { describe, it, expect, vi, beforeEach } from 'vitest';

const logToolCall = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/utils/ChatLogger.js', () => ({ logToolCall: (...a: any[]) => logToolCall(...a) }));
const runProjectBridge = vi.fn();
vi.mock('../src/tools/project-bridge.js', () => ({ runProjectBridge: (...a: any[]) => runProjectBridge(...a) }));

import { cyberTool } from '../src/tools/cyber-tool.js';

// C9: run_action failures answered success:false but were logged as non-errors, and actionName / target /
// authorization had no length or character limits before reaching a subprocess bridge.

const ok = { actionName: 'scan', target: 'https://example.com/', authorization: 'pentest engagement #42', workspaceRoot: process.cwd() };
const run = (extra: Record<string, unknown> = {}) => cyberTool({ action: 'run_action', ...ok, ...extra } as any) as Promise<any>;
const lastIsError = () => logToolCall.mock.calls[logToolCall.mock.calls.length - 1][5];

beforeEach(() => { logToolCall.mockClear(); runProjectBridge.mockReset(); });

describe('run_action failures are logged as errors', () => {
    it('missing authorization', async () => {
        const r = await run({ authorization: undefined });
        expect(r.success).toBe(false);
        expect(lastIsError()).toBe(true);
    });

    it('missing actionName or target', async () => {
        const r = await run({ actionName: undefined });
        expect(r.success).toBe(false);
        expect(lastIsError()).toBe(true);
    });

    it('a bridge that throws', async () => {
        runProjectBridge.mockRejectedValue(new Error('bridge exploded'));
        const r = await run();
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/bridge exploded/);
        expect(lastIsError()).toBe(true);
    });

    it('a success is not logged as an error', async () => {
        runProjectBridge.mockResolvedValue({ bridge: 'katana', finding: { ok: true } });
        const r = await run();
        expect(r.success).toBe(true);
        expect(lastIsError()).toBe(false);
    });
});

describe('run_action input limits', () => {
    it.each([
        ['actionName', 'x'.repeat(65)],
        ['actionName', 'scan; rm -rf /'],
        ['actionName', 'a b'],
        ['target', 'https://example.com/' + 'a'.repeat(2100)],
        ['target', 'host\nname'],
        ['authorization', 'y'.repeat(2001)],
    ])('rejects a bad %s before reaching the bridge', async (field, value) => {
        const r = await run({ [field]: value });
        expect(r.success).toBe(false);
        expect(r.error).toMatch(new RegExp(field, 'i'));
        expect(runProjectBridge).not.toHaveBeenCalled();
        expect(lastIsError()).toBe(true);
    });

    it('accepts ordinary values', async () => {
        runProjectBridge.mockResolvedValue({ bridge: 'katana', finding: {} });
        const r = await run({ actionName: 'crawl.deep-1', target: 'example.com:8080' });
        expect(r.success).toBe(true);
    });
});
