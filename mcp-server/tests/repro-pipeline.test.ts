import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IntelligentRouterMiddleware } from '../src/pipeline/middlewares/IntelligentRouterMiddleware.js';
import { TaskType, PipelineExecutor } from '../src/pipeline/middleware.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type { PipelineContext } from '../src/pipeline/middleware.js';

// Fully mock the registry via vi.spyOn to avoid ESM import issues with vi.mock
describe('IntelligentRouterMiddleware Strategic Repro', () => {
    let middleware: IntelligentRouterMiddleware;
    let mockExecutor: any;

    beforeEach(() => {
        // Reset registry instance for each test
        const registry = ProviderRegistry.getInstance();
        vi.spyOn(registry, 'getAvailableProviders').mockReturnValue([
            { id: 'mock-provider', name: 'Mock', baseURL: '', rateLimits: { rpm: 60 }, envVar: '', consecutiveFailures: 0, isAvailable: () => true, models: [{ id: 'gemini-2.0-flash' }], chat: vi.fn(), getPenaltyScore: () => 0, recordFailure: vi.fn(), getUsageStats: () => ({ requestCountMinute: 0, requestCountDay: 0 }), chatStream: vi.fn() } as any
        ]);
        vi.spyOn(registry, 'getProvider').mockReturnValue({
            id: 'mock-provider',
            name: 'Mock',
            baseURL: '',
            rateLimits: { rpm: 60 },
            envVar: '',
            consecutiveFailures: 0,
            isAvailable: () => true,
            getPenaltyScore: () => 0,
            recordFailure: vi.fn(),
            getUsageStats: () => ({ requestCountMinute: 0, requestCountDay: 0 }),
            chatStream: vi.fn(),
            chat: vi.fn().mockResolvedValue({
                choices: [{ message: { content: 'Strategic response' } }],
                model: 'gemini-2.0-flash',
                usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
            })
        } as any);

        mockExecutor = {
            calculateTokens: vi.fn().mockReturnValue(15000), // Force compression
            tryProvider: vi.fn().mockResolvedValue({
                choices: [{ message: { content: 'Success' } }],
                model: 'gemini-2.0-flash',
                usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
            }),
            flush: vi.fn(),
            getTokenState: vi.fn().mockReturnValue({})
        };
        middleware = new IntelligentRouterMiddleware(mockExecutor as any);
    });

    it('should identify a ReferenceError if one exists in the routing loop', async () => {
        const context: PipelineContext = {
            request: {
                model: 'gemini-2.0-flash',
                messages: [
                    { role: 'system', content: 'System prompt' },
                    { role: 'user', content: 'Review this code for logic and optimization'.repeat(500) }
                ]
            },
            keywords: ['review', 'python', 'logic', 'optimization']
        };

        const next = vi.fn().mockResolvedValue(undefined);

        // Run the middleware. If a ReferenceError occurs, it will throw here.
        await middleware.execute(context, next);
    });
});
