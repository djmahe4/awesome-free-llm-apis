import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    PipelineExecutor,
    TaskType,
    type PipelineContext,
    IntelligentRouterMiddleware,
    TokenManagerMiddleware
} from '../src/pipeline/index.js';
import { LLMExecutor } from '../src/utils/LLMExecutor.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type { ChatResponse } from '../src/providers/types.js';

describe('Pipeline Orchestration', () => {
    beforeEach(() => {
        vi.unstubAllEnvs();
        // Reset singleton
        (ProviderRegistry as any).instance = undefined;
    });

    it('PipelineExecutor executes middlewares in order', async () => {
        const pipeline = new PipelineExecutor();
        const sequence: string[] = [];

        pipeline.use({
            name: 'm1',
            execute: async (ctx, next) => {
                sequence.push('m1-start');
                await next();
                sequence.push('m1-end');
            }
        });

        pipeline.use({
            name: 'm2',
            execute: async (ctx, next) => {
                sequence.push('m2-start');
                await next();
                sequence.push('m2-end');
            }
        });

        const context: PipelineContext = {
            request: { model: 'test', messages: [] }
        };

        await pipeline.execute(context);
        expect(sequence).toEqual(['m1-start', 'm2-start', 'm2-end', 'm1-end']);
    });

    it('IntelligentRouterMiddleware selects correct model for task', async () => {
        // With free-first routing, OpenRouter is prioritized for Coding tasks
        vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-key');
        const registry = ProviderRegistry.getInstance();

        // Create a mocked executor to avoid real API calls
        const executor = new LLMExecutor();
        vi.spyOn(executor, 'tryProvider').mockImplementation(async (context, providerId, modelId) => {
            return {
                id: 'test',
                object: 'chat.completion',
                created: Date.now(),
                model: modelId,
                choices: [{ index: 0, message: { role: 'assistant', content: 'Test response' }, finish_reason: 'stop' }],
            } as ChatResponse;
        });

        const router = new IntelligentRouterMiddleware(executor);
        const context: PipelineContext = {
            request: { model: 'any', messages: [{ role: 'user', content: 'test' }] },
            taskType: TaskType.Coding
        };

        // Mock next to just record the chosen model
        const next = vi.fn();

        await router.execute(context, next);

        // Coding task should pick the best FREE coding model first (Qwen 480B via OpenRouter)
        expect(context.request.model).toBe('qwen/qwen3-coder:free');
        expect(context.providerId).toBe('openrouter');
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('IntelligentRouterMiddleware explicit model-to-provider routing checks', async () => {
        // Create a mocked executor to avoid real API calls
        const executor = new LLMExecutor();
        vi.spyOn(executor, 'tryProvider').mockImplementation(async (context, providerId, modelId) => {
            return {
                id: 'test',
                object: 'chat.completion',
                created: Date.now(),
                model: modelId,
                choices: [{ index: 0, message: { role: 'assistant', content: 'Test response' }, finish_reason: 'stop' }],
            } as ChatResponse;
        });

        const router = new IntelligentRouterMiddleware(executor);

        // Test 1: Gemini 3.1 Pro Preview routing
        vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key');
        let ctx1: PipelineContext = { request: { model: 'gemini-3.1-pro-preview', messages: [{ role: 'user', content: 'test' }] } };
        await router.execute(ctx1, vi.fn());
        expect(ctx1.providerId).toBe('gemini');

        // Test 2: Mistral routing
        vi.stubEnv('MISTRAL_API_KEY', 'test-mistral-key');
        let ctx2: PipelineContext = { request: { model: 'mistral-large-latest', messages: [{ role: 'user', content: 'test' }] } };
        await router.execute(ctx2, vi.fn());
        expect(ctx2.providerId).toBe('mistral');

        // Test 3: Kluster fallback routing for Qwen
        vi.stubEnv('KLUSTER_API_KEY', 'test-kluster-key');
        let ctx3: PipelineContext = { request: { model: 'Qwen/Qwen3-235B-A22B', messages: [{ role: 'user', content: 'test' }] } };
        await router.execute(ctx3, vi.fn());
        // Qwen is primarily on Nvidia and Kluster; whichever returns true first
        expect(['kluster', 'nvidia']).toContain(ctx3.providerId);
    });

    it('TokenManagerMiddleware estimates tokens and syncs from headers', async () => {
        const manager = new TokenManagerMiddleware();
        const context: PipelineContext = {
            request: {
                model: 'test',
                messages: [{ role: 'user', content: 'Hello world' }]
            },
            providerId: 'test-p'
        };

        const next = vi.fn().mockImplementation(async () => {
            context.response = {
                id: 'test',
                choices: [],
                _headers: {
                    'x-ratelimit-remaining-tokens': '5000',
                    'x-ratelimit-reset-tokens': '10'
                }
            } as any;
        });

        await manager.execute(context, next);

        expect(context.estimatedTokens).toBeGreaterThan(0);
        const stats = manager.getTrackingState();
        expect(stats['test-p'].remainingTokens).toBe(5000);
    });
});
