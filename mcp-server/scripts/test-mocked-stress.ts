import { ProviderRegistry } from '../src/providers/registry.js';
import { IntelligentRouterMiddleware } from '../src/pipeline/middlewares/IntelligentRouterMiddleware.js';
import { LLMExecutor } from '../src/utils/LLMExecutor.js';
import { TaskType, type PipelineContext } from '../src/pipeline/middleware.js';

async function runTests() {
    console.error('--- Context Management Mocked Stress Test ---');

    const executor = new LLMExecutor();

    // Inject mock providers
    const registry = ProviderRegistry.getInstance();
    (registry as any).providers = new Map(); // Clear real ones

    const mockModels = [
        { id: 'DeepSeek-R1', name: 'DS-R1', contextWindow: 64000 },
        { id: 'gemini-2.5-flash', name: 'Gemini Flash', contextWindow: 1000000 }
    ];

    ['mock-p1', 'mock-p2', 'mock-p3'].forEach(id => {
        (registry as any).providers.set(id, {
            id,
            name: `Mock ${id}`,
            models: mockModels,
            isAvailable: () => true,
            getPenaltyScore: () => 0,
            getUsageStats: () => ({ requestCountMinute: 0, requestCountDay: 0 }),
            rateLimits: { rpm: 60 },
            consecutiveFailures: 0,
            recordFailure: (status: number) => { },
            chat: async (req: any) => {
                console.error(`      [MOCK-P] ${id}.chat called (timeout: ${req.timeoutMs}ms)`);
                await new Promise(resolve => setTimeout(resolve, 50));
                throw new Error('[MOCK] Provider chat failed');
            }
        });
    });

    // Mock tryProvider to simulate delay and successful fallback
    let attemptCount = 0;
    executor.tryProvider = async (context, providerId, modelId, timeoutMs) => {
        attemptCount++;
        console.error(`   [MOCK] Attempt ${attemptCount}: ${providerId}/${modelId} (timeout: ${timeoutMs}ms)`);

        if (attemptCount < 3) {
            // Simulate a slow provider that eventually fails/times out
            const delay = Math.min(timeoutMs || 2000, 500);
            await new Promise(resolve => setTimeout(resolve, delay));
            throw new Error(`[MOCK FAILURE] ${providerId} too slow`);
        }

        return {
            id: 'mock-id',
            object: 'chat.completion',
            created: Date.now(),
            model: modelId,
            choices: [{
                index: 0,
                message: { role: 'assistant', content: 'Success after fallbacks!' },
                finish_reason: 'stop'
            }],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }
        };
    };

    // Mock prompt (used for summarization) to simulate delay
    executor.prompt = async (messages, model, options = {}) => {
        console.error(`   [MOCK] Summarization attempt (timeout: ${options.timeoutMs || 'default'}ms)`);
        await new Promise(resolve => setTimeout(resolve, 200));
        throw new Error('[MOCK] Summarization failed to force Tier 2');
    };

    const router = new IntelligentRouterMiddleware(executor);

    console.error('\n--- Test 1: Forced Fallback & Timeout Budgeting ---');
    const ctx1: PipelineContext = {
        taskType: TaskType.Chat,
        request: {
            model: 'auto',
            messages: [{ role: 'user', content: 'Short prompt' }], // No compression
            timeoutMs: 10000
        }
    };

    try {
        const start = Date.now();
        await router.execute(ctx1, async () => { console.error('   Next called!'); });
        const duration = Date.now() - start;
        console.error(`✅ Success in ${duration}ms!`);
        console.error('   Providers attempted:', (ctx1 as any).providersAttempted);
    } catch (e: any) {
        console.error('❌ Failed:', e.message);
        console.error('   Providers attempted:', (ctx1 as any).providersAttempted);
    }

    console.error('\n--- Test 2: Emergency Truncation (Tier 2) ---');
    const extremeText = 'B'.repeat(100000); // Massive prompt
    const ctx2: PipelineContext = {
        taskType: TaskType.Chat,
        request: {
            model: 'auto',
            messages: [{ role: 'user', content: extremeText }],
            timeoutMs: 30000
        }
    };

    try {
        await router.execute(ctx2, async () => { });
        console.error('✅ Success:', ctx2.request.model);
        const hasTruncated = ctx2.request.messages.some(m => m.content.includes('[...truncated...]'));
        console.error('   Emergency truncation triggered:', hasTruncated);
    } catch (e: any) {
        console.error('❌ Failed:', e.message);
    }
}

runTests().catch(console.error);
