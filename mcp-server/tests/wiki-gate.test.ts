import { describe, it, expect, vi, beforeEach } from 'vitest';
import { memoryManager } from '../src/memory/index.js';
import { WorkspaceContextMiddleware } from '../src/pipeline/middlewares/WorkspaceContextMiddleware.js';

const getWikiSpy = vi.spyOn(memoryManager, 'getWiki');

beforeEach(() => {
    getWikiSpy.mockClear();
});

function makeContext(opts: { workspaceRoot?: string; isOnePass: boolean; sessionId: string }): any {
    return {
        request: {
            model: 'gemini-3.1-flash-lite',
            agentic: false,
            messages: [{ role: 'user', content: 'Audit authentication flow and harden session tokens' }]
        },
        taskType: 'coder',
        keywords: ['session', 'tokens'],
        sessionId: opts.sessionId,
        isOnePass: opts.isOnePass,
        ...(opts.workspaceRoot !== undefined ? { workspaceRoot: opts.workspaceRoot } : {})
    };
}

describe('wiki lookup gating', () => {
    it('skips the wiki lookup for workspace-agnostic one-shots', async () => {
        const middleware = new WorkspaceContextMiddleware();
        const context = makeContext({ isOnePass: true, sessionId: 'wiki-gate-nows' });

        await middleware.execute(context, async () => {});

        // No workspaceRoot => no workspace-keyed wiki knowledge may be consulted
        // (wikiNamespace would otherwise fall back to the server-cwd hash).
        expect(getWikiSpy).not.toHaveBeenCalled();
        expect(context.telemetry?.steeringTelemetry?.memoryLayers?.wikiTokens ?? 0).toBe(0);
    });

    it('still consults the wiki when a workspace is provided', async () => {
        getWikiSpy.mockReturnValue({
            search: vi.fn().mockResolvedValue([]),
            write: vi.fn()
        } as any);
        try {
            const middleware = new WorkspaceContextMiddleware();
            const context = makeContext({ isOnePass: true, sessionId: 'wiki-gate-ws', workspaceRoot: process.cwd() });

            await middleware.execute(context, async () => {});

            expect(getWikiSpy).toHaveBeenCalled();
        } finally {
            getWikiSpy.mockRestore();
        }
    });
});
