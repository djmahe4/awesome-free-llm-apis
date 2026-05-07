import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IntelligentRouterMiddleware } from '../src/pipeline/middlewares/IntelligentRouterMiddleware.js';
import { TaskType } from '../src/pipeline/middleware.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { LLMExecutor } from '../src/utils/LLMExecutor.js';

// Mock ProviderRegistry
vi.mock('../src/providers/registry.js', () => {
    return {
        ProviderRegistry: {
            getInstance: vi.fn()
        }
    };
});

// Mock Persistence
vi.mock('../src/utils/PersistenceManager.js', () => ({
    persistence: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined)
    }
}));

describe('Fallback Parameter Stripping', () => {
    let router: IntelligentRouterMiddleware;
    let executor: LLMExecutor;

    beforeEach(() => {
        vi.clearAllMocks();
        executor = new LLMExecutor();
        router = new IntelligentRouterMiddleware(executor);
    });

    it('should strip google_search when falling back from Gemini to a non-Gemini provider', async () => {
        // 1. Setup providers
        const mockGemini = {
            id: 'gemini',
            models: [{ id: 'gemini-2.5-flash', contextWindow: 128000 }],
            chat: vi.fn().mockRejectedValue(new Error('Rate limit')),
            getUsageStats: () => ({ requestCountMinute: 0 }),
            rateLimits: { rpm: 60 },
            recordFailure: vi.fn(),
            recordSuccess: vi.fn()
        };

        const mockMistral = {
            id: 'mistral',
            models: [{ id: 'mistral-large-latest', contextWindow: 32000 }],
            chat: vi.fn().mockResolvedValue({
                choices: [{ message: { content: 'Success from Mistral' } }],
                _headers: {}
            }),
            getUsageStats: () => ({ requestCountMinute: 0 }),
            rateLimits: { rpm: 60 },
            recordFailure: vi.fn(),
            recordSuccess: vi.fn()
        };

        const registry = {
            getAvailableProviders: () => [mockGemini, mockMistral],
            getProvider: (id: string) => id === 'gemini' ? mockGemini : mockMistral
        };

        (ProviderRegistry.getInstance as any).mockReturnValue(registry);

        // 2. Setup context with google_search and TaskType.SemanticSearch
        const context: any = {
            request: {
                messages: [{ role: 'user', content: 'Search for pizza' }],
                google_search: true,
                agentic: true,
                sessionId: 'test-session'
            },
            taskType: TaskType.SemanticSearch
        };

        // 3. Execute router
        await router.execute(context, async () => {});

        // 4. Verify Mistral was called WITHOUT google_search and sessionId
        expect(mockMistral.chat).toHaveBeenCalled();
        const callArgs = mockMistral.chat.mock.calls[0][0];
        expect(callArgs.google_search).toBeUndefined();
        expect(callArgs.sessionId).toBeUndefined();
        expect(callArgs.agentic).toBeUndefined();
        expect(callArgs.model).toBe('mistral-large-latest');
    });
});
