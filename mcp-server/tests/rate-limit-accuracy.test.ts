import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock node-fetch BEFORE anything else imports it
vi.mock('node-fetch', () => {
    return {
        default: vi.fn()
    };
});

import fetch from 'node-fetch';
import { BaseProvider } from '../src/providers/base.js';
import { ChatRequest, ChatResponse, Message, RateLimits } from '../src/providers/types.js';
import { IntelligentRouterMiddleware } from '../src/pipeline/middlewares/IntelligentRouterMiddleware.js';
import { LLMExecutor } from '../src/utils/LLMExecutor.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { TaskType } from '../src/pipeline/middleware.js';

// Minimal implementation of BaseProvider for testing
class TestProvider extends BaseProvider {
    name = 'Test';
    id = 'test';
    baseURL = 'https://api.test.ai/v1/';
    envVar = 'TEST_API_KEY';
    rateLimits: RateLimits = { rpm: 10, rpd: 50 };
    models = [{ id: 'gemini-2.5-flash', name: 'Gemini', contextWindow: 200 }];
}

describe('Rate Limit & Token Accuracy', () => {
    let provider: TestProvider;

    beforeEach(() => {
        provider = new TestProvider();
        process.env.TEST_API_KEY = 'valid_key_1234567890';
        vi.resetAllMocks();
    });

    it('should NOT increment counters if checkRateLimit throws', async () => {
        const checkSpy = vi.spyOn(provider as any, 'checkRateLimit').mockImplementation(() => {
            throw new Error('Pre-check failure');
        });

        try {
            await provider.chat({ model: 'gemini-2.5-flash', messages: [] });
        } catch (e) { }

        checkSpy.mockImplementation(() => { });
        const usageAfter = provider.getUsageStats();
        expect(usageAfter.requestCountMinute).toBe(0);
    });

    it('should NOT increment counters if fetch fails (success-based tracking)', async () => {
        (fetch as any).mockRejectedValue(new Error('Network failure'));
        const usageBefore = provider.getUsageStats();

        try {
            await provider.chat({ model: 'gemini-2.5-flash', messages: [] });
        } catch (e) { }

        const usageAfter = provider.getUsageStats();
        expect(usageAfter.requestCountMinute).toBe(usageBefore.requestCountMinute);
    });

    it('should NOT increment if API key is missing', async () => {
        const usageBefore = provider.getUsageStats();
        vi.stubEnv('TEST_API_KEY', '');

        try {
            await provider.chat({ model: 'gemini-2.5-flash', messages: [] });
        } catch (e) { }

        const usageAfter = provider.getUsageStats();
        expect(usageAfter.requestCountMinute).toBe(usageBefore.requestCountMinute);
    });

    it('should increment counters on successful 200 response', async () => {
        (fetch as any).mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { role: 'assistant', content: 'OK' } }]
            }),
            headers: new Map()
        });

        await provider.chat({ model: 'gemini-2.5-flash', messages: [] });
        expect(provider.getUsageStats().requestCountMinute).toBe(1);
    });
});

describe('Orchestration Accuracy (Fallback & Compression)', () => {
    let executor: LLMExecutor;
    let router: IntelligentRouterMiddleware;
    let registry: ProviderRegistry;

    beforeEach(() => {
        vi.resetAllMocks();
        executor = new LLMExecutor();
        router = new IntelligentRouterMiddleware(executor);
        registry = ProviderRegistry.getInstance();
        (registry as any).providers = new Map();
    });

    it('should only increment RPM for the SUCCESSFUL provider in a fallback chain', async () => {
        const p1 = new TestProvider();
        p1.id = 'p1'; p1.envVar = 'P1_KEY'; process.env.P1_KEY = 'key1234567890';

        const p2 = new TestProvider();
        p2.id = 'p2'; p2.envVar = 'P2_KEY'; process.env.P2_KEY = 'key2234567890';

        registry.registerProvider(p1);
        registry.registerProvider(p2);

        // P1 fails with 429
        (fetch as any).mockResolvedValueOnce({
            ok: false,
            status: 429,
            text: async () => 'Rate limit'
        });

        // P2 succeeds
        (fetch as any).mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { role: 'assistant', content: 'OK' } }],
                usage: { total_tokens: 10 }
            }),
            headers: new Map()
        });

        const context: any = {
            request: { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'test' }] },
            taskType: TaskType.Chat
        };

        await router.execute(context, async () => { });

        expect(p1.getUsageStats().requestCountMinute).toBe(0);
        expect(p2.getUsageStats().requestCountMinute).toBe(1);
    });

    it('should increment RPM for both summarizer and final providers', async () => {
        const p = new TestProvider();
        p.id = 'p'; p.models[0].contextWindow = 200; process.env.TEST_API_KEY = 'key1234567890';
        registry.registerProvider(p);

        // REAL HUGE messages to ensure ContextManager sees overflow
        const messages: Message[] = Array(10).fill({
            role: 'user',
            content: 'A'.repeat(100) // 10 * 100 = 1000 chars, well over 200 tokens
        });

        // Dynamic token calculation based on content length
        vi.spyOn(executor, 'calculateTokens').mockImplementation((messages: any) => {
            const totalLength = messages.reduce((acc: number, m: any) => acc + (m.content?.length || 0), 0);
            return Math.ceil(totalLength / 4);
        });

        // SUCCESS for summarization AND final call
        (fetch as any).mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { role: 'assistant', content: 'Success' } }],
                usage: { total_tokens: 50 }
            }),
            headers: new Map()
        });

        const context: any = {
            request: { model: 'gemini-2.5-flash', messages, max_tokens: 50 },
            taskType: TaskType.Chat
        };

        await router.execute(context, async () => { });

        // RPM should be 2 (1 for summary, 1 for final)
        expect(p.getUsageStats().requestCountMinute).toBe(2);
    });

    it('should handle compression correctly when no history exists (single large message)', async () => {
        const p = new TestProvider();
        p.id = 'p'; p.models[0].contextWindow = 100; process.env.TEST_API_KEY = 'key1234567890';
        registry.registerProvider(p);

        // One HUGE message (no "old" messages for sliding window)
        const messages: Message[] = [{
            role: 'user',
            content: 'A'.repeat(1000)
        }];

        const context: any = {
            request: { model: 'gemini-2.5-flash', messages, max_tokens: 10 },
            taskType: TaskType.Chat
        };

        (fetch as any).mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }),
            headers: new Map()
        });

        await router.execute(context, async () => { });

        // Succeeded via truncation
        expect(p.getUsageStats().requestCountMinute).toBe(1);
        // Should contain 'truncated' in any form
        expect(context.request.messages[0].content.toLowerCase()).toContain('truncated');
    });
});
