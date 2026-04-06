import { ProviderRegistry } from '../src/providers/registry.js';
import { IntelligentRouterMiddleware } from '../src/pipeline/middlewares/IntelligentRouterMiddleware.js';
import { LLMExecutor } from '../src/utils/LLMExecutor.js';
import { TaskType, type PipelineContext } from '../src/pipeline/middleware.js';

async function runTests() {
    console.log('--- Deep Compression & Failover Debug Test ---');

    const registry = ProviderRegistry.getInstance();
    const availableProviders = registry.getAllProviders().filter(p => p.isAvailable());
    if (availableProviders.length === 0) {
        console.log('No providers available. Ensure .env is loaded.');
        process.exit(1);
    }

    const executor = new LLMExecutor();

    let providerLog: string[] = [];

    executor.tryProvider = async (context, providerId, modelId) => {
        providerLog.push(`${providerId}/${modelId}`);

        // Fail for all primary models, succeed only for emergency ones
        const isEmergency = providerLog.some(log => log.startsWith('EMERGENCY:')) || (context as any).providersAttempted?.some((p: string) => p.startsWith('EMERGENCY:'));

        if (!isEmergency) {
            throw new Error(`[SIMULATED FAILURE] Provider ${providerId} logic error`);
        }

        // If emergency, return a mock response
        return {
            id: 'mock-id',
            object: 'chat.completion',
            created: Date.now(),
            model: modelId,
            choices: [{
                index: 0,
                message: { role: 'assistant', content: 'Success from emergency fallback!' },
                finish_reason: 'stop'
            }],
            usage: { prompt_tokens: 1500, completion_tokens: 10, total_tokens: 1510 }
        };
    };

    const router = new IntelligentRouterMiddleware(executor);

    // console.log('\n--- Test 1: Failover Simulation ---');
    // providerLog = [];
    // const ctx1: PipelineContext = {
    //     request: {
    //         model: 'failover-test',
    //         messages: [{ role: 'user', content: 'Say hello' }],
    //         max_tokens: 20
    //     },
    //     taskType: TaskType.Chat
    // };

    // try {
    //     await router.execute(ctx1, async () => { console.log('Next called!'); });
    //     console.log('✅ Success:', ctx1.providerId, ctx1.request.model);
    //     console.log('Providers tried:', (ctx1 as any).providersAttempted);
    // } catch (e: any) {
    //     console.log('❌ Failed:', e.message);
    //     console.log('Providers tried:', (ctx1 as any).providersAttempted);
    // }

    console.log('\n--- Test 2: Massive Prompt (forces emergency loop through window disqualification) ---');
    providerLog = [];
    const largeText = 'A'.repeat(50000); // 50k characters
    const prompt = 'Please perform a test with this massive input. ' + largeText;
    const ctx2: PipelineContext = {
        taskType: TaskType.Chat,
        request: {
            model: 'auto',
            messages: [{ role: 'user', content: prompt }]
        }
    };

    try {
        await router.execute(ctx2, async () => { console.log('Next called!'); });
        console.log('✅ Success:', ctx2.providerId, ctx2.request.model);
        console.log('Final messages string sizes:', ctx2.request.messages.map(m => m.content.length));
        if (ctx2.request.messages.length > 0) {
            const lastMsg = ctx2.request.messages[ctx2.request.messages.length - 1];
            if (lastMsg.content.includes('[...truncated...]')) {
                console.log('✅ TRUNCATION DETECTED in message content!');
            }
        }
        console.log('Providers tried:', (ctx2 as any).providersAttempted);
    } catch (e: any) {
        console.log('❌ Failed:', e.message);
        console.log('Providers tried:', (ctx2 as any).providersAttempted);
    }
}

runTests().catch(console.error);
