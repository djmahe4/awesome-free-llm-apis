import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    TaskType,
    type PipelineContext,
    IntelligentRouterMiddleware
} from '../src/pipeline/index.js';
import { LLMExecutor } from '../src/utils/LLMExecutor.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { BaseProvider } from '../src/providers/base.js';

// Mock Provider implementation
class MockProvider extends BaseProvider {
    name: string;
    id: string;
    baseURL = 'http://mock';
    envVar: string;
    models: any[];
    rateLimits: any;

    constructor(id: string, models: any[], rpm: number) {
        super();
        this.id = id;
        this.name = `Mock ${id}`;
        this.envVar = `${id.toUpperCase()}_API_KEY`;
        // Ensure models have a default context window if not provided
        this.models = models.map(m => ({ 
            contextWindow: 8192, 
            ...m 
        }));
        this.rateLimits = { rpm };
        vi.stubEnv(this.envVar, 'mock-key-is-sufficiently-long');
    }
    
    // Support new token tracking metrics
    override getUsageStats() { 
        return { 
            requestCountMinute: 0, 
            requestCountDay: 0, 
            tokenCountMinute: 0, 
            tokenCountDay: 0 
        }; 
    }
    
    override isAvailable(): boolean {
        return true;
    }

}

describe('Intelligent Router - Dynamic Scoring & Filtering', () => {
    beforeEach(() => {
        vi.unstubAllEnvs();
        (ProviderRegistry as any).instance = undefined;
    });

    it('should filter out models with insufficient context window', async () => {
        const registry = ProviderRegistry.getInstance();
        const executor = new LLMExecutor();
        const router = new IntelligentRouterMiddleware(executor);

        // Provider with small context
        const prov1 = new MockProvider('prov1', [{ id: 'model-a', name: 'Model A', contextWindow: 1000 }], 60);
        // Provider with large context
        const prov2 = new MockProvider('prov2', [{ id: 'model-a', name: 'Model A', contextWindow: 8000 }], 60);

        registry.registerProvider(prov1);
        registry.registerProvider(prov2);

        // Mock token calculation to avoid slow encoding in test
        vi.spyOn(executor, 'calculateTokens').mockReturnValue(2000);

        // Prompt that we want to be ~2000 tokens
        const context: PipelineContext = {
            request: {
                model: 'model-a',
                messages: [{ role: 'user', content: 'large content' }]
            },
            taskType: TaskType.Chat
        };

        const trySpy = vi.spyOn(executor, 'tryProvider').mockResolvedValue({ id: 'ok' } as any);

        await router.execute(context, async () => { });

        // Should ONLY have tried prov2 (prov1 rejected due to context window)
        expect(trySpy).toHaveBeenCalledTimes(1);
        expect(trySpy).toHaveBeenCalledWith(expect.anything(), 'prov2', 'model-a', expect.any(Number));
    });

    it('should rank providers by rate limit headroom', async () => {
        const registry = ProviderRegistry.getInstance();
        const executor = new LLMExecutor();
        const router = new IntelligentRouterMiddleware(executor);

        // Prov1: 50% used
        const prov1 = new MockProvider('prov1', [{ id: 'm1', name: 'M1' }], 100);
        vi.spyOn(prov1, 'getUsageStats').mockReturnValue({ requestCountMinute: 50, requestCountDay: 50, tokenCountMinute: 0, tokenCountDay: 0 });


        // Prov2: 10% used (Better)
        const prov2 = new MockProvider('prov2', [{ id: 'm1', name: 'M1' }], 100);
        vi.spyOn(prov2, 'getUsageStats').mockReturnValue({ requestCountMinute: 10, requestCountDay: 10, tokenCountMinute: 0, tokenCountDay: 0 });


        registry.registerProvider(prov1);
        registry.registerProvider(prov2);

        const context: PipelineContext = {
            request: { model: 'm1', messages: [{ role: 'user', content: 'test' }] },
            taskType: TaskType.Chat
        };

        const attempts: string[] = [];
        vi.spyOn(executor, 'tryProvider').mockImplementation(async (ctx, pid) => {
            attempts.push(pid);
            return { id: 'ok' } as any;
        });

        await router.execute(context, async () => { });

        // Prov2 should be tried first because it has more headroom
        expect(attempts[0]).toBe('prov2');
    });

    it('should rank providers by token availability status', async () => {
        const registry = ProviderRegistry.getInstance();
        const executor = new LLMExecutor();
        const router = new IntelligentRouterMiddleware(executor);

        const prov1 = new MockProvider('prov1', [{ id: 'm1', name: 'M1' }], 100);
        const prov2 = new MockProvider('prov2', [{ id: 'm1', name: 'M1' }], 100);

        registry.registerProvider(prov1);
        registry.registerProvider(prov2);

        // Mock token states
        executor.setTokenState({
            'prov1': { remainingTokens: 10000 },  // Low tokens
            'prov2': { remainingTokens: 90000 }   // High tokens (Better)
        });

        const context: PipelineContext = {
            request: { model: 'm1', messages: [{ role: 'user', content: 'test' }] },
            taskType: TaskType.Chat
        };

        const attempts: string[] = [];
        vi.spyOn(executor, 'tryProvider').mockImplementation(async (ctx, pid) => {
            attempts.push(pid);
            return { id: 'ok' } as any;
        });

        await router.execute(context, async () => { });

        // Prov2 should be tried first because it has more tokens
        expect(attempts[0]).toBe('prov2');
    });

    it('should prioritize requested model but still pick best provider for it', async () => {
        const registry = ProviderRegistry.getInstance();
        const executor = new LLMExecutor();
        const router = new IntelligentRouterMiddleware(executor);

        // Requested model: model-b
        // Model tiers: model-b (requested), then model-a (fallback)
        const provA = new MockProvider('provA', [{ id: 'model-a', name: 'M-A' }], 100);
        const provB_Low = new MockProvider('provB_Low', [{ id: 'model-b', name: 'M-B' }], 100);
        const provB_High = new MockProvider('provB_High', [{ id: 'model-b', name: 'M-B' }], 100);

        vi.spyOn(provB_Low, 'getUsageStats').mockReturnValue({ requestCountMinute: 90, requestCountDay: 90, tokenCountMinute: 0, tokenCountDay: 0 });
        vi.spyOn(provB_High, 'getUsageStats').mockReturnValue({ requestCountMinute: 0, requestCountDay: 0, tokenCountMinute: 0, tokenCountDay: 0 });


        registry.registerProvider(provA);
        registry.registerProvider(provB_Low);
        registry.registerProvider(provB_High);

        const context: PipelineContext = {
            request: { model: 'model-b', messages: [{ role: 'user', content: 'test' }] },
            taskType: TaskType.Chat
        };

        const attempts: string[] = [];
        vi.spyOn(executor, 'tryProvider').mockImplementation(async (ctx, pid) => {
            attempts.push(pid);
            return { id: 'ok' } as any;
        });

        await router.execute(context, async () => { });

        // Should try model-b first, and pick provB_High over provB_Low
        expect(attempts[0]).toBe('provB_High');
    });

    it('should bypass upscaling check if model is explicitly requested', async () => {
        const registry = ProviderRegistry.getInstance();
        const executor = new LLMExecutor();
        const router = new IntelligentRouterMiddleware(executor);

        // Requested model: 'small-model' (1k window)
        const smallProv = new MockProvider('smallProv', [{ id: 'small-model', name: 'Small', contextWindow: 1000 }], 60);
        // Fallback model: 'large-model' (8k window)
        const largeProv = new MockProvider('largeProv', [{ id: 'large-model', name: 'Large', contextWindow: 8000 }], 60);

        registry.registerProvider(smallProv);
        registry.registerProvider(largeProv);

        // Mock token calculation to be 900 (90% of small-model window)
        // Normally this would trigger upscaling (>80%) and SKIP small-model
        vi.spyOn(executor, 'calculateTokens').mockReturnValue(900);

        const context: PipelineContext = {
            request: {
                model: 'small-model', // EXPLICIT REQUEST
                messages: [{ role: 'user', content: 'large content' }]
            },
            taskType: TaskType.Chat
        };

        const trySpy = vi.spyOn(executor, 'tryProvider').mockResolvedValue({ id: 'ok' } as any);

        await router.execute(context, async () => { });

        // Should HAVE tried small-model (bypassing the 80% upscaling check because it was explicitly requested)
        expect(trySpy).toHaveBeenCalledWith(expect.anything(), 'smallProv', 'small-model', expect.any(Number));
    });

    it('should apply penalty score to recently rate-limited providers', async () => {
        const registry = ProviderRegistry.getInstance();
        const executor = new LLMExecutor();
        const router = new IntelligentRouterMiddleware(executor);

        const prov1 = new MockProvider('prov1', [{ id: 'm1', name: 'M1' }], 100);
        const prov2 = new MockProvider('prov2', [{ id: 'm1', name: 'M1' }], 100);

        registry.registerProvider(prov1);
        registry.registerProvider(prov2);

        // Simulate that prov1 recently had a 429 failure
        (prov1 as any).recordFailure(429);

        const context: PipelineContext = {
            request: { model: 'm1', messages: [{ role: 'user', content: 'test' }] },
            taskType: TaskType.Chat
        };

        const attempts: string[] = [];
        vi.spyOn(executor, 'tryProvider').mockImplementation(async (ctx, pid) => {
            attempts.push(pid);
            return null; // Force cascade to test ranking order
        });

        try {
            await router.execute(context, async () => { });
        } catch { }

        // Prov2 should be tried before Prov1 because Prov1 has a 429 penalty
        expect(attempts[0]).toBe('prov2');
        expect(attempts[1]).toBe('prov1');
    });

    it('should ignore requested models that do not exist in any available provider', async () => {
        const registry = ProviderRegistry.getInstance();
        const executor = new LLMExecutor();
        const router = new IntelligentRouterMiddleware(executor);

        const prov = new MockProvider('prov', [{ id: 'real-model', name: 'Real' }], 100);
        registry.registerProvider(prov);
        // By default, fallback tier models include "gemini-2.5-flash" (we overwrite taskRouteMap for test predictable behaviour if needed)

        const context: PipelineContext = {
            request: { model: 'made-up-model', messages: [{ role: 'user', content: 'test' }] },
            taskType: TaskType.Chat
        };

        const attempts: string[] = [];
        vi.spyOn(executor, 'tryProvider').mockImplementation(async (ctx, pid, mid) => {
            attempts.push(mid);
            return null; // Force cascade
        });

        try {
            await router.execute(context, async () => { });
        } catch { }

        // It should NOT attempt 'made-up-model' at all.
        expect(attempts).not.toContain('made-up-model');
    });
});
