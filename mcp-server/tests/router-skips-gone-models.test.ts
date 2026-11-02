import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IntelligentRouterMiddleware, type PipelineContext } from '../src/pipeline/index.js';
import { LLMExecutor } from '../src/utils/LLMExecutor.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type { ChatResponse } from '../src/providers/types.js';

// #142: once a provider has said a model is gone, the router stops asking for it.
describe('router skips a model the provider said is gone', () => {
    beforeEach(() => {
        vi.unstubAllEnvs();
        (ProviderRegistry as any).instance = undefined;
    });

    it('does not call the gone model again', async () => {
        const executor = new LLMExecutor();
        const p1 = { id: 'p1', models: [{ id: 'dead-model' }, { id: 'live-model' }] };
        const registry = ProviderRegistry.getInstance();
        vi.spyOn(registry, 'getAvailableProviders').mockReturnValue([p1 as any]);
        vi.spyOn(registry, 'getProviderForModel').mockReturnValue(p1 as any);

        executor.recordProviderFailure('p1', 404, 'dead-model: model not found', 'dead-model');

        const called: string[] = [];
        vi.spyOn(executor, 'tryProvider').mockImplementation(async (_c, providerId, modelId) => {
            called.push(`${providerId}/${modelId}`);
            return { id: 't', object: 'chat.completion', created: 1, model: modelId, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] } as ChatResponse;
        });

        const router = new IntelligentRouterMiddleware(executor);
        const context: PipelineContext = { request: { model: 'any', messages: [{ role: 'user', content: 'hi' }] } };
        await router.execute(context, vi.fn());

        expect(called).not.toContain('p1/dead-model');
        expect(called).toContain('p1/live-model');
    });

    it('does not call a provider that refused our credentials', async () => {
        const executor = new LLMExecutor();
        const p1 = { id: 'p1', models: [{ id: 'm' }] };
        const p2 = { id: 'p2', models: [{ id: 'm' }] };
        const registry = ProviderRegistry.getInstance();
        vi.spyOn(registry, 'getAvailableProviders').mockReturnValue([p1 as any, p2 as any]);
        vi.spyOn(registry, 'getProviderForModel').mockReturnValue(p1 as any);

        executor.recordProviderFailure('p1', 401, 'bind your account', 'm');

        const called: string[] = [];
        vi.spyOn(executor, 'tryProvider').mockImplementation(async (_c, providerId, modelId) => {
            called.push(providerId);
            return { id: 't', object: 'chat.completion', created: 1, model: modelId, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] } as ChatResponse;
        });

        const router = new IntelligentRouterMiddleware(executor);
        const context: PipelineContext = { request: { model: 'any', messages: [{ role: 'user', content: 'hi' }] } };
        await router.execute(context, vi.fn());

        expect(called).not.toContain('p1');
        expect(called).toContain('p2');
    });
});
