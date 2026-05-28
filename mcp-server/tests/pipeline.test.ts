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
        expect(context.request.model).toBe('qwen/qwen3-coder-480b-a35b:free');
        expect(context.providerId).toBe('openrouter');
    });

    it('IntelligentRouterMiddleware implements sequential fallback when provider fails', async () => {
        const executor = new LLMExecutor();
        const provider1 = { id: 'p1', models: [{ id: 'm1', contextWindow: 8192 }] };
        const provider2 = { id: 'p2', models: [{ id: 'm1', contextWindow: 8192 }] };
        
        const registry = ProviderRegistry.getInstance();
        vi.spyOn(registry, 'getAvailableProviders').mockReturnValue([provider1 as any, provider2 as any]);
        vi.spyOn(registry, 'getProviderForModel').mockReturnValue(provider1 as any);

        let callCount = 0;
        vi.spyOn(executor, 'tryProvider').mockImplementation(async (context, providerId, modelId) => {
            callCount++;
            if (providerId === 'p1') {
                throw new Error('Provider 1 failed');
            }
            return {
                id: 'test',
                object: 'chat.completion',
                created: Date.now(),
                model: modelId,
                choices: [{ index: 0, message: { role: 'assistant', content: 'Success' }, finish_reason: 'stop' }],
            } as ChatResponse;
        });

        const router = new IntelligentRouterMiddleware(executor);
        const context: PipelineContext = {
            request: { model: 'm1', messages: [{ role: 'user', content: 'test' }] }
        };

        const next = vi.fn();
        await router.execute(context, next);

        expect(callCount).toBe(2);
        expect(context.providerId).toBe('p2');
        expect(context.response?.choices[0].message.content).toBe('Success');
    });

    it('IntelligentRouterMiddleware prioritizes providers with higher scores (reputation/circuit breaker)', async () => {
        const executor = new LLMExecutor();
        const provider1 = { id: 'p1', models: [{ id: 'm1', contextWindow: 8192 }] }; 
        const provider2 = { id: 'p2', models: [{ id: 'm1', contextWindow: 8192 }] };

        const registry = ProviderRegistry.getInstance();
        vi.spyOn(registry, 'getAvailableProviders').mockReturnValue([provider1 as any, provider2 as any]);
        vi.spyOn(registry, 'getProviderForModel').mockReturnValue(provider1 as any);

        vi.spyOn(executor, 'getProviderStats').mockReturnValue({
            'p1': { circuitOpen: true } as any,
            'p2': { circuitOpen: false } as any
        });

        vi.spyOn(executor, 'tryProvider').mockImplementation(async (context, providerId, modelId) => {
            return {
                id: 'test',
                object: 'chat.completion',
                created: Date.now(),
                model: modelId,
                choices: [{ index: 0, message: { role: 'assistant', content: 'Success' }, finish_reason: 'stop' }],
            } as ChatResponse;
        });

        const router = new IntelligentRouterMiddleware(executor);
        const context: PipelineContext = {
            request: { model: 'm1', messages: [{ role: 'user', content: 'test' }] }
        };

        const next = vi.fn();
        await router.execute(context, next);

        expect(context.providerId).toBe('p2');
    });

    it('IntelligentRouterMiddleware penalizes weak models for heavy prompts', async () => {
        const executor = new LLMExecutor();
        const providerHigh = { id: 'p_high', models: [{ id: 'qwen/qwen3-coder-480b-a35b-instruct' }] };
        const providerLow = { id: 'p_low', models: [{ id: 'nvidia/nemotron-mini-4b-instruct' }] };

        const registry = ProviderRegistry.getInstance();
        vi.spyOn(registry, 'getAvailableProviders').mockReturnValue([providerLow as any, providerHigh as any]);
        vi.spyOn(registry, 'getProviderForModel').mockReturnValue(providerHigh as any);

        vi.spyOn(executor, 'tryProvider').mockImplementation(async (context, providerId, modelId) => {
            return {
                id: 'test',
                object: 'chat.completion',
                created: Date.now(),
                model: modelId,
                choices: [{ index: 0, message: { role: 'assistant', content: 'Success' }, finish_reason: 'stop' }],
            } as ChatResponse;
        });

        const router = new IntelligentRouterMiddleware(executor);
        const context: PipelineContext = {
            request: { 
                model: 'any', 
                messages: [{ role: 'user', content: 'heavy prompt' }],
                estimatedTokens: 10000
            }
        };

        const next = vi.fn();
        await router.execute(context, next);

        expect(context.providerId).toBe('p_high');
    });

    it('IntelligentRouterMiddleware explicit model-to-provider routing checks', async () => {
        const executor = new LLMExecutor();
        const provider1 = { id: 'p1', models: [{ id: 'm1' }] }; 
        const provider2 = { id: 'p2', models: [{ id: 'm1' }] };

        const registry = ProviderRegistry.getInstance();
        vi.spyOn(registry, 'getAvailableProviders').mockReturnValue([provider1 as any, provider2 as any]);
        vi.spyOn(registry, 'getProviderForModel').mockReturnValue(provider1 as any);

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
            request: { model: 'any', messages: [{ role: 'user', content: 'test' }] }
        };

        const next = vi.fn();
        await router.execute(context, next);

        expect(context.providerId).toBe('p1');
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

    it('IntelligentRouterMiddleware concatenates thinking/reasoning into content and cleans artifacts', async () => {
        const executor = new LLMExecutor();
        vi.spyOn(executor, 'tryProvider').mockImplementation(async (context, providerId, modelId) => {
            return {
                id: 'test',
                object: 'chat.completion',
                created: Date.now(),
                model: modelId,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: '\n{\n  "result": "ok"\n}\n',
                        thinking: 'Thinking about the bracket fix'
                    } as any,
                    finish_reason: 'stop'
                }],
            } as ChatResponse;
        });

        const registry = ProviderRegistry.getInstance();
        const geminiProvider = registry.getProvider('gemini')!;
        vi.spyOn(registry, 'getAvailableProviders').mockReturnValue([geminiProvider]);
        vi.spyOn(registry, 'getProviderForModel').mockReturnValue(geminiProvider);

        const router = new IntelligentRouterMiddleware(executor);

        const context: PipelineContext = {
            request: { model: 'gemini-exp-1206', messages: [{ role: 'user', content: 'test' }] }
        };

        await router.execute(context, vi.fn());

        const res = context.response as any;
        const msg = res.choices[0].message;

        // Should have THOUGHTS
        expect(msg.content).toContain('THOUGHTS: Thinking about the bracket fix');
        // Should have the cleaned result (no newline before '{')
        expect(msg.content).toMatch(/bracket fix\{/);
        expect(msg.content).toContain('"result": "ok"');
        // Original thinking field should be deleted
        expect(msg.thinking).toBeUndefined();
    });
});
