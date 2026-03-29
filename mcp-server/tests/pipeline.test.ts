import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    PipelineExecutor,
    TaskType,
    type PipelineContext,
    IntelligentRouterMiddleware,
    TokenManagerMiddleware,
    LLMExecutionMiddleware
} from '../src/pipeline/index.js';
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
        vi.stubEnv('KLUSTER_API_KEY', 'test-key-long-enough');
        const registry = ProviderRegistry.getInstance();

        const router = new IntelligentRouterMiddleware();
        const context: PipelineContext = {
            request: { model: 'any', messages: [] },
            taskType: TaskType.Coding
        };

        // Mock next to just record the chosen model
        const next = vi.fn().mockImplementation(async () => {
            context.response = { id: 'test', model: context.request.model, choices: [] } as any;
        });

        await router.execute(context, next);

        // Coding task should pick DeepSeek from Kluster (as it's stubbed and available)
        expect(context.request.model).toBe('deepseek-ai/DeepSeek-R1');
        expect(context.providerId).toBe('kluster');
    });

    it('IntelligentRouterMiddleware explicit model-to-provider routing checks', async () => {
        const registry = ProviderRegistry.getInstance();
        const router = new IntelligentRouterMiddleware();

        // Test 1: Gemini 3.1 Pro Preview routing
        vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key');
        let ctx1: PipelineContext = { request: { model: 'gemini-3.1-pro-preview', messages: [] } };
        await router.execute(ctx1, vi.fn().mockImplementation(async () => {
            ctx1.response = { id: 'test', choices: [] } as any;
        }));
        expect(ctx1.providerId).toBe('gemini');

        // Test 2: Mistral routing
        vi.stubEnv('MISTRAL_API_KEY', 'test-mistral-key');
        let ctx2: PipelineContext = { request: { model: 'mistral-large-latest', messages: [] } };
        await router.execute(ctx2, vi.fn().mockImplementation(async () => {
            ctx2.response = { id: 'test', choices: [] } as any;
        }));
        expect(ctx2.providerId).toBe('mistral');

        // Test 3: Kluster fallback routing for Qwen
        vi.stubEnv('KLUSTER_API_KEY', 'test-kluster-key');
        let ctx3: PipelineContext = { request: { model: 'Qwen/Qwen3-235B-A22B', messages: [] } };
        await router.execute(ctx3, vi.fn().mockImplementation(async () => {
            ctx3.response = { id: 'test', choices: [] } as any;
        }));
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

    it('LLMExecutionMiddleware calls the provider', async () => {
        const registry = ProviderRegistry.getInstance();
        const groq = registry.getProvider('groq');
        if (!groq) throw new Error('Groq not found');

        const mockResponse: ChatResponse = {
            id: 'resp-1',
            object: 'chat.completion',
            created: Date.now(),
            model: 'test-model',
            choices: [],
        };

        vi.spyOn(groq, 'chat').mockResolvedValue(mockResponse);

        const exec = new LLMExecutionMiddleware();
        const context: PipelineContext = {
            request: { model: 'test-model', messages: [] },
            providerId: 'groq'
        };

        await exec.execute(context, async () => { });

        expect(context.response).toEqual(mockResponse);
    });
});
