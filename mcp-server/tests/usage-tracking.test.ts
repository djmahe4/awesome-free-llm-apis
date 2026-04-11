import { describe, it, expect, beforeEach } from 'vitest';
import { LLMExecutor } from '../src/utils/LLMExecutor.js';
import type { PipelineContext } from '../src/pipeline/index.js';
import { TaskType } from '../src/pipeline/index.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { BaseProvider } from '../src/providers/base.js';

class MockProvider extends BaseProvider {
    id = 'mock-provider';
    name = 'Mock Provider';
    baseURL = 'http://mock';
    envVar = 'MOCK_API_KEY';
    rateLimits = { rpm: 60 };
    models = [{ id: 'mock-model', name: 'Mock Model' }];
    
    async chat() {
        return {
            id: 'res-1',
            choices: [{ message: { role: 'assistant', content: 'hello' }, index: 0, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            model: 'mock-model',
            object: 'chat.completion',
            created: Date.now()
        } as any;
    }
}

describe('Usage Tracking Hardening', () => {
    let executor: LLMExecutor;
    
    beforeEach(() => {
        executor = new LLMExecutor();
        const registry = ProviderRegistry.getInstance();
        (registry as any).providers = new Map();
        registry.registerProvider(new MockProvider());
    });

    it('should initialize local tracking counters even without API headers', async () => {
        const context: PipelineContext = {
            request: { messages: [{ role: 'user', content: 'test' }] },
            taskType: TaskType.Chat
        };

        // Execute provider call
        await executor.tryProvider(context, 'mock-provider', 'mock-model');

        const state = executor.getTokenState()['mock-provider'];
        
        expect(state).toBeDefined();
        expect(state.localTotalRequests).toBe(1);
        expect(state.localTotalTokens).toBeGreaterThan(0);
        // remainingTokens should be undefined because no headers were returned by MockProvider
        expect(state.remainingTokens).toBeUndefined();
    });

    it('should accumulate local totals over multiple calls', async () => {
        const context: PipelineContext = {
            request: { messages: [{ role: 'user', content: 'test' }] },
            taskType: TaskType.Chat
        };

        await executor.tryProvider(context, 'mock-provider', 'mock-model');
        await executor.tryProvider(context, 'mock-provider', 'mock-model');

        const state = executor.getTokenState()['mock-provider'];
        expect(state.localTotalRequests).toBe(2);
    });
});
