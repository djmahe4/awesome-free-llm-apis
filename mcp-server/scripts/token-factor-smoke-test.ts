import { LLMExecutor } from '../src/utils/LLMExecutor.js';
import { IntelligentRouterMiddleware } from '../src/pipeline/middlewares/IntelligentRouterMiddleware.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { PipelineContext, TaskType } from '../src/pipeline/middleware.js';

async function testTokenFactor() {
    console.error('=== Token Factor Multi-Provider Smoke Test ===\n');

    const executor = new LLMExecutor();
    const router = new IntelligentRouterMiddleware(executor);
    const registry = ProviderRegistry.getInstance();
    
    // Identify providers for our target model
    const targetModel = 'awesome-shared-model';
    const groq = registry.getProvider('groq');
    const hf = registry.getProvider('huggingface');
    const or = registry.getProvider('openrouter');

    if (!groq || !hf || !or) {
        console.error('Error: This test requires groq, huggingface, and openrouter providers.');
        return;
    }

    // Force all of them to support the shared model for the test
    [groq, hf, or].forEach(p => {
        if (!p.models.some(m => m.id === targetModel)) {
            p.models.push({ id: targetModel, name: 'Shared Test Model' });
        }
    });

    const providers = [groq, hf, or];

    console.error('--- Initializing Provider States (Gradient) ---');
    
    // 1. OpenRouter: Healthy (100k) -> Factor ~1.2
    console.error(`Setting ${or.id}: 100,000 remaining tokens (Expect Factor ~1.2)`);
    executor.updateProviderTokenState(or.id, {
        remainingTokens: 100000,
        remainingRequests: 50,
        requestsRefreshTime: Date.now() + 60000
    });

    // 2. HuggingFace: Moderate (30k) -> Factor ~0.6
    console.error(`Setting ${hf.id}: 30,000 remaining tokens (Expect Factor ~0.6)`);
    executor.updateProviderTokenState(hf.id, {
        remainingTokens: 30000,
        remainingRequests: 50,
        requestsRefreshTime: Date.now() + 60000
    });

    // 3. Groq: Scarcity (5k) -> Factor ~0.1
    console.error(`Setting ${groq.id}: 5,000 remaining tokens (Expect Factor ~0.1)`);
    executor.updateProviderTokenState(groq.id, {
        remainingTokens: 5000,
        remainingRequests: 50,
        requestsRefreshTime: Date.now() + 60000
    });

    const pipelineContext: PipelineContext = {
        request: {
            model: targetModel,
            messages: [{ role: 'user', content: 'Say "Orchestration Test"' }]
        },
        metadata: {}
    };

    console.error('\n--- Scenario: Choosing between High, Moderate, and Low Token Providers ---');
    
    const next = async () => {
        console.error('\n[Test] Next called. Final Selection:', pipelineContext.providerId);
    };

    try {
        await router.execute(pipelineContext, next);
    } catch (e: any) {
        console.error('\nExecution finished. Message:', e.message);
    }

    console.error('\n--- Verify "Drift Correction" (Mocking Header Update) ---');
    if (groq) {
        console.error('Mocking response headers for groq: 25k tokens remaining...');
        // We simulate a response that would update the tracker
        const mockHeaders = {
            'x-ratelimit-remaining-tokens': '25000',
            'x-ratelimit-reset-tokens': '10'
        };
        
        // Use a private-ish method via any to simulate what happens during tryProvider
        (executor as any).updateTokenTracking(groq.id, mockHeaders);
        
        const state = executor.getTokenState()[groq.id];
        console.error(`New tracked state for groq: ${state.remainingTokens} tokens (Expect Factor ~0.5)`);
    }

    console.error('\nSmoke test complete.');
}

testTokenFactor().catch(console.error);
