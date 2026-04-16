import { ProviderRegistry } from '../src/providers/registry.js';
import { IntelligentRouterMiddleware } from '../src/pipeline/middlewares/IntelligentRouterMiddleware.js';
import { LLMExecutor } from '../src/utils/LLMExecutor.js';
import { TaskType, type PipelineContext } from '../src/pipeline/middleware.js';


async function runTests() {
    console.error('--- Context Management & Stress Test ---');

    const isSimulated = process.env.SIMULATE === 'true';
    const registry = ProviderRegistry.getInstance();
    const executor = new LLMExecutor();

    if (isSimulated) {
        console.error('🚀 RUNNING IN SIMULATION MODE (Mocked Providers)');
        
        // 1. Clear real providers and inject mocks
        (registry as any).providers = new Map();
        
        const mockModels = [
            { id: 'DeepSeek-R1', name: 'DS-R1', contextWindow: 64000 },
            { id: 'gemini-2.0-flash', name: 'Gemini Flash', contextWindow: 1000000 }
        ];

        // Simulation Wrapper logic (Race emulation)
        const wrapWithTimeout = (id: string, chatFn: (req: any) => Promise<any>) => async (req: any) => {
            const timeoutMs = req.timeoutMs || 30000;
            return Promise.race([
                chatFn(req),
                new Promise((_, reject) => setTimeout(() => {
                    console.error(`      [BASEPROVIDER MOCK] ${id} HARD TIMEOUT after ${timeoutMs}ms`);
                    reject(new Error(`[MOCK] Request timed out after ${timeoutMs}ms`));
                }, timeoutMs))
            ]);
        };

        // Standard mock success provider
        (registry as any).providers.set('mock-p1', {
            id: 'mock-p1',
            name: 'Mock Success P1',
            models: mockModels,
            isAvailable: () => true,
            getPenaltyScore: () => 0,
            getUsageStats: () => ({ requestCountMinute: 0, requestCountDay: 0 }),
            rateLimits: { rpm: 60 },
            consecutiveFailures: 0,
            recordFailure: () => {},
            chat: wrapWithTimeout('mock-p1', async () => {
                await new Promise(resolve => setTimeout(resolve, 100));
                return {
                    choices: [{ message: { content: 'Stress Test Success!' } }],
                    usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 }
                };
            })
        });

        // 2. Mock summarization to fail to force Tier 2 Truncation
        executor.prompt = async (messages, model, options = {}) => {
            console.error(`   [MOCK] Summarization attempt triggered (timeout: ${options.timeoutMs}ms)`);
            throw new Error('[MOCK] Summarization failed to force truncation');
        };

    } else {
        const availableProviders = registry.getAllProviders().filter(p => p.isAvailable());
        if (availableProviders.length === 0) {
            console.error('No providers available. Ensure .env is loaded or run with SIMULATE=true.');
            process.exit(1);
        }
    }

    const router = new IntelligentRouterMiddleware(executor);

    console.error('\n--- Test 1: Context Pressure (Real API Attempt) ---');
    // Using ~16,000 chars as per evaluate-routing.ts Stress Case
    const largeText = 'A'.repeat(16000); 
    const prompt = 'Repeat after me: Context test. ' + largeText;
    
    const ctx1: PipelineContext = {
        taskType: TaskType.Chat,
        request: {
            model: 'auto',
            messages: [{ role: 'user', content: prompt }],
            timeoutMs: 120000 // Bump to 120s for real stress scenario
        }
    };

    console.error(`   Estimated Tokens: ${executor.calculateTokens(ctx1.request.messages)}`);

    try {
        const start = Date.now();
        await router.execute(ctx1, async () => { console.error('   Next called!'); });
        const duration = Date.now() - start;
        console.error(`✅ Success in ${duration}ms:`, ctx1.providerId, ctx1.request.model);
        console.error('   Compression strategy used:', (ctx1 as any).compressionStrategy || 'none');
        if ((ctx1 as any).providersAttempted) {
            console.error('   Providers tried:', (ctx1 as any).providersAttempted);
        }
    } catch (e: any) {
        console.error('❌ Failed:', e.message);
        if ((ctx1 as any).providersAttempted) {
            console.error('   Providers tried:', (ctx1 as any).providersAttempted);
        }
    }

    console.error('\n--- Test 2: Massive Prompt (Extreme Pressure - Simulated) ---');
    const extremeText = 'B'.repeat(100000); // 100k characters (~25k-40k tokens)
    const ctx2: PipelineContext = {
        taskType: TaskType.Chat,
        request: {
            model: 'auto',
            messages: [{ role: 'user', content: extremeText }],
            timeoutMs: 30000
        }
    };

    try {
        await router.execute(ctx2, async () => {});
        console.error('✅ Success:', ctx2.providerId, ctx2.request.model);
        if (ctx2.request.messages.some(m => m.content.includes('[...truncated...]'))) {
            console.error('   ✅ Emergency truncation verified.');
        }
    } catch (e: any) {
        console.error('❌ Failed:', e.message);
    }
}

runTests().catch(console.error);
