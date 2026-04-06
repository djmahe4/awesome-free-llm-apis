import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextManager } from '../src/utils/ContextManager.js';
import type { Message } from '../src/providers/types.js';
import {
    TaskType,
    type PipelineContext,
    IntelligentRouterMiddleware
} from '../src/pipeline/index.js';
import { LLMExecutor } from '../src/utils/LLMExecutor.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { BaseProvider } from '../src/providers/base.js';
import type { ChatResponse, RateLimits, ProviderModel } from '../src/providers/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class MockProvider extends BaseProvider {
    name: string; id: string; baseURL = 'http://mock'; envVar: string;
    models: ProviderModel[]; rateLimits: RateLimits;
    constructor(id: string, models: any[], rpm: number) {
        super();
        this.id = id;
        this.name = `Mock ${id}`;
        this.envVar = `${id.toUpperCase()}_API_KEY`;
        this.models = models.map(m => ({
            contextWindow: 8192,
            ...m
        }));
        this.rateLimits = { rpm };
        vi.stubEnv(this.envVar, 'mock-key-is-sufficiently-long');
    }
    override isAvailable(): boolean {
        return true;
    }
}

function makeContext(contentLength = 100): PipelineContext {
    return {
        request: {
            model: 'any',
            messages: [{ role: 'user', content: 'w '.repeat(contentLength) }],
            max_tokens: 64,
        },
        taskType: TaskType.Chat,
    };
}

// ---------------------------------------------------------------------------
// ContextManager unit tests
// ---------------------------------------------------------------------------

describe('ContextManager', () => {
    let cm: ContextManager;

    beforeEach(() => { cm = new ContextManager(); });

    it('returns original messages when they already fit', async () => {
        const msgs: Message[] = [{ role: 'user', content: 'Hello world' }];
        const noopSummarizer = vi.fn();
        const result = await cm.slidingWindow(msgs, 100_000, noopSummarizer);
        expect(result.messages).toEqual(msgs);
        expect(noopSummarizer).not.toHaveBeenCalled();
    });

    it('summarizes old messages and preserves recent ones', async () => {
        const msgs: Message[] = [
            { role: 'user', content: 'First old message' },
            { role: 'assistant', content: 'First old reply' },
            { role: 'user', content: 'Second old message' },
            { role: 'assistant', content: 'Second old reply' },
            { role: 'user', content: 'Recent question' },      // keep verbatim
            { role: 'assistant', content: 'Recent answer' },   // keep verbatim
        ];

        const mockSummarizer = vi.fn().mockResolvedValue('Summary of old conversation');
        const targetTokens = 80; // Force compression

        const result = await cm.slidingWindow(msgs, targetTokens, mockSummarizer);

        expect(mockSummarizer).toHaveBeenCalledOnce();
        // Summary injected as system message
        expect(result.messages.some(m => m.content.includes('Summary of old conversation'))).toBe(true);
        // Recent messages preserved verbatim
        expect(result.messages.some(m => m.content === 'Recent question')).toBe(true);
        expect(result.messages.some(m => m.content === 'Recent answer')).toBe(true);
        // Old messages dropped
        expect(result.messages.find(m => m.content === 'First old message')).toBeUndefined();
    });

    it('falls back to truncate-oldest when summarizer fails', async () => {
        const msgs: Message[] = Array.from({ length: 10 }, (_, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `Message ${i} ${'word '.repeat(50)}`,
        } as Message));

        const failingSummarizer = vi.fn().mockRejectedValue(new Error('summarizer failed'));
        const result = await cm.slidingWindow(msgs, 50, failingSummarizer);
        expect(result.strategy).toBe('truncate-oldest');
        expect(result.compressedTokens).toBeLessThanOrEqual(result.originalTokens);
    });

    it('truncate-oldest removes oldest non-system messages', () => {
        const msgs: Message[] = [
            { role: 'system', content: 'System prompt' },
            { role: 'user', content: 'Old message ' + 'a '.repeat(200) },       // should be removed
            { role: 'assistant', content: 'Old reply ' + 'a '.repeat(200) },    // may be removed
            { role: 'user', content: 'Recent question' },                        // should survive
        ];

        const result = cm.truncateOldest(msgs, 50);

        // System prompt must survive
        expect(result.messages.some(m => m.role === 'system')).toBe(true);
        // Most recent message should survive
        expect(result.messages.some(m => m.content === 'Recent question')).toBe(true);
        expect(result.strategy).toBe('truncate-oldest');
    });

    it('chunkMapReduce splits large content and merges results', async () => {
        // Create a context with a long user message
        const longContent = 'word '.repeat(400); // ~400 words
        const ctx: PipelineContext = {
            request: { model: 'any', messages: [{ role: 'user', content: longContent }] },
            taskType: TaskType.Summarization,
        };

        const chunkResults: string[] = [];
        const executor = vi.fn().mockImplementation(async (chunkCtx: PipelineContext) => {
            const content = chunkCtx.request.messages.at(-1)!.content;
            chunkResults.push(`processed(${content.length})`);
            return `processed(${content.length})`;
        });

        const reducer = vi.fn().mockImplementation(async (parts: string[]) => {
            return `merged: ${parts.join(' | ')}`;
        });

        const result = await cm.chunkMapReduce(ctx, 200, executor, reducer);

        expect(executor.mock.calls.length).toBeGreaterThan(1); // Multiple chunks
        expect(reducer).toHaveBeenCalledOnce();
        expect(result).toContain('merged:');
    });
});

// ---------------------------------------------------------------------------
// Integration: Router auto-compresses context when prompt is too large
// ---------------------------------------------------------------------------

describe('Router Context Overflow Auto-Compression', () => {
    beforeEach(() => {
        vi.unstubAllEnvs();
        (ProviderRegistry as any).instance = undefined;
    });

    it('compresses context and succeeds when prompt exceeds all model windows', async () => {
        const registry = ProviderRegistry.getInstance();
        const executor = new LLMExecutor();
        const router = new IntelligentRouterMiddleware(executor);

        // Provider whose model exists in the Summarization taskRouteMap —
        // contextWindow=500 is smaller than our 600-word prompt (~620 tokens)
        // but big enough for the 64-token summary text passed to the summarizer.
        const smallProvider = new MockProvider(
            'cloudflare',
            [{ id: 'llama-3.3-70b-versatile', name: 'Llama 70B', contextWindow: 100 }],
            100
        );
        registry.registerProvider(smallProvider);
        vi.spyOn(registry, 'getAvailableProviders').mockReturnValue([smallProvider]);

        // Mock token logic to trigger overflow then success
        const calcTokensSpy2 = vi.spyOn(executor, 'calculateTokens');
        calcTokensSpy2.mockReturnValueOnce(5000); // Trigger > 4000 compression
        calcTokensSpy2.mockReturnValue(50);      // All subsequent (after compression)

        const context: PipelineContext = {
            request: {
                model: 'llama-3.3-70b-versatile',
                messages: [
                    { role: 'user', content: 'Long history info. '.repeat(50) },
                    { role: 'assistant', content: 'Long history response. '.repeat(50) },
                    { role: 'user', content: 'Msg 2. '.repeat(50) },
                    { role: 'assistant', content: 'R2. '.repeat(50) },
                    { role: 'user', content: 'Msg 3. '.repeat(50) },
                    { role: 'assistant', content: 'R3. '.repeat(50) },
                    { role: 'user', content: 'Current active message' },
                ],
                max_tokens: 20,
            },
            taskType: TaskType.Summarization,
        };

        // Mock token calculation to force overflow (150 > 100) then success after compression (50 <= 100)

        let callCount = 0;
        vi.spyOn(executor, 'tryProvider').mockImplementation(async (ctx, pid, mid) => {
            callCount++;
            console.debug(`[TestMock] tryProvider called for ${mid} (total: ${callCount})`);
            return {
                id: 'resp',
                object: 'chat.completion',
                created: Date.now(),
                model: mid,
                choices: [{ index: 0, message: { role: 'assistant', content: 'Mock response' }, finish_reason: 'stop' }],
            } as ChatResponse;
        });

        await router.execute(context, async () => { });

        // exactly 1 call: heuristic compression (Tier 0) is synchronous and doesn't call an LLM.
        // After Tier 0, tokens are 50, which fits in the 100 context window.
        expect(callCount).toBe(1);
        expect(context.response).toBeDefined();
        expect((context as any).contextCompressed).toBe(true);
    });

    it('passes through unmodified when prompt fits within context window', async () => {
        const registry = ProviderRegistry.getInstance();
        const executor = new LLMExecutor();
        const router = new IntelligentRouterMiddleware(executor);

        const largeProvider = new MockProvider(
            'large',
            [{ id: 'model-large', name: 'Large Model', contextWindow: 128000 }],
            100
        );
        vi.spyOn(registry, 'getAvailableProviders').mockReturnValue([largeProvider]);
        vi.spyOn(registry, 'getAllProviders').mockReturnValue([largeProvider]);

        const context: PipelineContext = {
            request: {
                model: 'model-large',
                messages: [{ role: 'user', content: 'Short prompt' }],
                max_tokens: 512,
            },
            taskType: TaskType.Chat,
        };

        let callCount = 0;
        vi.spyOn(executor, 'tryProvider').mockImplementation(async () => {
            callCount++;
            return {
                id: 'resp',
                object: 'chat.completion',
                created: Date.now(),
                model: 'model-large',
                choices: [{ index: 0, message: { role: 'assistant', content: 'Answer' }, finish_reason: 'stop' }],
            } as ChatResponse;
        });

        await router.execute(context, async () => { });

        // Exactly 1 call — no compression step
        expect(callCount).toBe(1);
        expect((context as any).contextCompressed).toBeUndefined();
    });
});
