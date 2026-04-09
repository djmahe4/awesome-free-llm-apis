import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IntelligentRouterMiddleware } from '../src/pipeline/middlewares/IntelligentRouterMiddleware.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { TaskType } from '../src/pipeline/middleware.js';
import type { PipelineContext } from '../src/pipeline/middleware.js';

vi.mock('../src/providers/registry.js', () => {
    return {
        ProviderRegistry: {
            getInstance: vi.fn().mockReturnValue({
                getAvailableProviders: vi.fn().mockReturnValue([
                    { id: 'mock', name: 'Mock', baseURL: '', models: [{ id: 'gemini-2.5-flash', contextWindow: 128000 }], chat: vi.fn(), chatStream: vi.fn(), getPenaltyScore: () => 0, isAvailable: () => true, recordFailure: vi.fn(), getUsageStats: () => ({ requestCountMinute: 0, requestCountDay: 0 }), rateLimits: { rpm: 60 }, envVar: '', consecutiveFailures: 0 }
                ]),
                getProvider: vi.fn().mockReturnValue({
                    id: 'mock',
                    name: 'Mock',
                    baseURL: '',
                    models: [{ id: 'gemini-2.5-flash', contextWindow: 128000 }],
                    isAvailable: () => true,
                    getPenaltyScore: () => 0,
                    recordFailure: vi.fn(),
                    getUsageStats: () => ({ requestCountMinute: 0, requestCountDay: 0 }),
                    rateLimits: { rpm: 60 },
                    envVar: '',
                    consecutiveFailures: 0,
                    chatStream: vi.fn(),
                    chat: vi.fn().mockResolvedValue({ choices: [{ message: { content: 'OK' } }] })
                })
            })
        }
    };
});

describe('IntelligentRouterMiddleware Full Repro', () => {
    let middleware: IntelligentRouterMiddleware;
    let mockExecutor: any;

    beforeEach(() => {
        mockExecutor = {
            calculateTokens: vi.fn().mockReturnValue(15000),
            tryProvider: vi.fn().mockResolvedValue({
                choices: [{ message: { content: 'Success' } }],
                model: 'qwen/qwen3-coder-4806-a35b-instruct:free',
                usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
            }),
            flush: vi.fn(),
            getTokenState: vi.fn().mockReturnValue({})
        };
        middleware = new IntelligentRouterMiddleware(mockExecutor as any);
    });

    it('should run without ReferenceError', async () => {
        const context: PipelineContext = {
            request: {
                model: 'gemini-2.5-flash',
                messages: [
                    { role: 'system', content: 'System prompt' },
                    { role: 'user', content: 'User message'.repeat(1000) }
                ]
            },
            keywords: ['review', 'python', 'logic', 'optimization']
        };

        const next = vi.fn().mockResolvedValue(undefined);
        await middleware.execute(context, next);
    });
});
