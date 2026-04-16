import { ProviderRegistry } from '../src/providers/registry.js';
import { IntelligentRouterMiddleware } from '../src/pipeline/middlewares/IntelligentRouterMiddleware.js';
import { LLMExecutor } from '../src/utils/LLMExecutor.js';
import { TaskType, type PipelineContext } from '../src/pipeline/middleware.js';

async function verify() {
    console.error('--- Individual Context Pressure Verification ---');
    console.error('Targeting the specific failure: 16k chars, 30s budget\n');

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

        // We simulate the BaseProvider's race logic here since these mocks avoid real network calls
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

        // Provider A: Stalls to verify hard timeout rejection
        (registry as any).providers.set('mock-stall-p', {
            id: 'mock-stall-p',
            name: 'Mock Stall Provider',
            models: mockModels,
            isAvailable: () => true,
            getPenaltyScore: () => 0,
            getUsageStats: () => ({ requestCountMinute: 0, requestCountDay: 0 }),
            rateLimits: { rpm: 60 },
            consecutiveFailures: 0,
            recordFailure: () => {},
            chat: wrapWithTimeout('mock-stall-p', async (req: any) => {
                const wait = (req.timeoutMs || 2000) + 1000;
                console.error(`      [MOCK] mock-stall-p: Starting stall for ${wait}ms...`);
                await new Promise(resolve => setTimeout(resolve, wait));
                return { choices: [{ message: { content: 'Slow success' } }] };
            })
        });

        // Provider B: Succeeds immediately
        (registry as any).providers.set('mock-success-p', {
            id: 'mock-success-p',
            name: 'Mock Success Provider',
            models: mockModels,
            isAvailable: () => true,
            getPenaltyScore: () => 0,
            getUsageStats: () => ({ requestCountMinute: 0, requestCountDay: 0 }),
            rateLimits: { rpm: 60 },
            consecutiveFailures: 0,
            recordFailure: () => {},
            chat: wrapWithTimeout('mock-success-p', async () => {
                await new Promise(resolve => setTimeout(resolve, 100)); // Minimal delay
                return {
                    id: 'mock-id',
                    object: 'chat.completion',
                    created: Date.now(),
                    model: 'DeepSeek-R1',
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: 'Simulation Success!' },
                        finish_reason: 'stop'
                    }],
                    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }
                };
            })
        });

        // 2. Mock summarization to fail (force Tier 2 Truncation)
        executor.prompt = async (messages, model, options = {}) => {
            console.error(`   [MOCK] Summarization attempt triggered (timeout: ${options.timeoutMs}ms)`);
            throw new Error('[MOCK] Summarization failed to force Tier 2 Truncation');
        };
    } else {
        const availableProviders = registry.getAllProviders().filter(p => p.isAvailable());
        if (availableProviders.length === 0) {
            console.error('❌ Error: No available providers found. Run with SIMULATE=true for mocked test.');
            process.exit(1);
        }
    }
    
    const router = new IntelligentRouterMiddleware(executor);

    // Scenario: 16k chars, 30s budget
    const prompt = 'Repeat after me: Context test. ' + 'A'.repeat(16000);
    
    const ctx: PipelineContext = {
        taskType: TaskType.Chat,
        request: {
            model: 'auto',
            messages: [{ role: 'user', content: prompt }],
            timeoutMs: 30000
        }
    };

    try {
        const start = Date.now();
        console.error(`[Test] Starting with ${executor.calculateTokens(ctx.request.messages)} estimated tokens...`);
        
        await router.execute(ctx, async () => { 
            console.error('   [Test] Next called (Task logic executed)'); 
        });
        
        const duration = Date.now() - start;
        console.error(`\n✅ VERIFICATION SUCCESS: ${duration}ms`);
        console.error(`📍 Provider: ${ctx.providerId}`);
        console.error(`🤖 Model: ${ctx.request.model}`);
        if ((ctx as any).providersAttempted) {
            console.error('🔄 Fallbacks tried:', (ctx as any).providersAttempted.length - 1);
            console.error('📍 Providers attempted:', (ctx as any).providersAttempted);
        }
    } catch (e: any) {
        console.error(`\n❌ VERIFICATION FAILED: ${e.message}`);
        if ((ctx as any).providersAttempted) {
            console.error('📍 Providers attempted:', (ctx as any).providersAttempted);
        }
        process.exit(1);
    }
}

verify().catch(console.error);
