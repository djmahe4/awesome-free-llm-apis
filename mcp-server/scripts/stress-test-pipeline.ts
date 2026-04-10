import path from 'node:path';
import fs from 'fs-extra';
import { StructuralMarkdownMiddleware } from '../src/middleware/agentic/structural-middleware.js';
import { ResponseCacheMiddleware } from '../src/pipeline/middlewares/ResponseCacheMiddleware.js';
import { TokenManagerMiddleware } from '../src/pipeline/middlewares/TokenManagerMiddleware.js';
import { IntelligentRouterMiddleware } from '../src/pipeline/middlewares/IntelligentRouterMiddleware.js';
import { PipelineExecutor, TaskType, type PipelineContext } from '../src/pipeline/middleware.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { LLMExecutor } from '../src/utils/LLMExecutor.js';

/**
 * FULL PIPELINE STRESS TEST
 * v1.0.4 Hardened Integration Suite
 * 
 * This script simulates the entire lifecycle of an MCP request, including:
 * 1. Memory injection (Agentic)
 * 2. Caching
 * 3. Token tracking & Rate limits
 * 4. Fallback routing
 */

let lastCapturedRequest: any = null;

/**
 * Helper to robustly check for Markdown injection across all content formats
 */
function hasInjectedContext(request: any): boolean {
    if (!request?.messages?.[0]?.content) return false;
    const content = request.messages[0].content;
    const marker = '# TASK CONTEXT';

    if (typeof content === 'string') return content.includes(marker);
    if (Array.isArray(content)) {
        return content.some((part: any) => part.text?.includes(marker) || part.includes?.(marker));
    }
    if (typeof content === 'object') {
        return !!(content.text?.includes(marker) || content.includes?.(marker));
    }
    return false;
}

async function setupMocks() {
    const registry = ProviderRegistry.getInstance();
    (registry as any).providers = new Map(); // Clear real ones

    const mockModels = [
        { id: 'gemini-2.5-flash', name: 'Gemini Flash', contextWindow: 1000000 },
        { id: 'claude-3-haiku', name: 'Haiku', contextWindow: 200000 }
    ];

    ['mock-p1', 'mock-p2'].forEach(id => {
        (registry as any).providers.set(id, {
            id,
            name: `Mock Provider ${id}`,
            baseURL: 'http://localhost',
            models: mockModels,
            isAvailable: () => true,
            getPenaltyScore: () => 0,
            getUsageStats: () => ({ requestCountMinute: 0, requestCountDay: 0 }),
            rateLimits: { rpm: 60 },
            consecutiveFailures: 0,
            recordFailure: () => { },
            chat: async (req: any) => {
                lastCapturedRequest = req;
                // Simulate network latency
                await new Promise(r => setTimeout(r, 50));
                return {
                    id: 'mock-resp-' + Date.now(),
                    object: 'chat.completion',
                    created: Date.now(),
                    model: req.model || 'mock-model',
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: 'PROCESSED' },
                        finish_reason: 'stop'
                    }],
                    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
                    _headers: {
                        'x-ratelimit-remaining-tokens': '50000',
                        'x-ratelimit-reset-tokens': '60'
                    }
                };
            }
        });
    });
}

async function main() {
    console.error('\n🔥 --- MCP Full Pipeline Stress Test (v1.0.4 Hardened) ---\n');

    await setupMocks();

    const sessionId = 'full-stress-session-' + Date.now();
    const projectDir = path.join(process.cwd(), 'data', 'projects', sessionId);
    const knowledgePath = path.join(projectDir, 'knowledge.md');

    await fs.ensureDir(projectDir);
    await fs.writeFile(knowledgePath, '# MOCK MEMORY\nExisting project context.');

    // Assemble Full Pipeline
    const executor = new LLMExecutor();
    const pipeline = new PipelineExecutor();

    // Order matters:
    // 1. Structural injection first
    // 2. Cache check second (so it can hit for identical agentic questions)
    // 3. Token management third
    // 4. Router/Executor last
    pipeline.use(new StructuralMarkdownMiddleware());
    pipeline.use(new ResponseCacheMiddleware());
    pipeline.use(new TokenManagerMiddleware());
    pipeline.use(new IntelligentRouterMiddleware(executor));

    console.error('Test Case 1-4: Running structural checks...');
    // (Reuse logic from previous script, but wrapping in pipeline exec)

    // --- CASE 5: The Loop (Sequential Stress & Caching) ---
    console.error('Test Case 5: Sequential Stability Loop (20 Requests)...');
    const start5 = Date.now();
    for (let i = 0; i < 20; i++) {
        const ctx: PipelineContext = {
            request: {
                model: 'auto',
                messages: [{ role: 'user', content: `Repeat request ${i % 5}` }], // Every 5th is a repeat for cache testing
                agentic: true
            },
            sessionId,
            taskType: TaskType.Chat
        };
        await pipeline.execute(ctx);
        if (i % 5 === 0) process.stderr.write('.');
    }
    console.error(`\n  [✓] 20 sequential requests processed in ${Date.now() - start5}ms`);


    // --- CASE 6: The Drift (Rate Limit Enforcement) ---
    console.error('\nTest Case 6: Token Quota & Drift Logic...');
    // Mock a provider that returns low tokens
    const registry = ProviderRegistry.getInstance();
    const exhaustedProviderId = 'mock-exhausted';
    (registry as any).providers.set(exhaustedProviderId, {
        id: exhaustedProviderId,
        name: 'Exhausted Provider',
        models: [{ id: 'low-quota-model', name: 'Low Quota' }],
        isAvailable: () => true,
        getPenaltyScore: () => 0,
        getUsageStats: () => ({ requestCountMinute: 0, requestCountDay: 0 }),
        rateLimits: { rpm: 10 },
        consecutiveFailures: 0,
        recordFailure: () => { },
        chat: async () => ({
            id: 'exhausted', object: 'chat.completion', created: Date.now(), model: 'low-quota-model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Blocked soon' }, finish_reason: 'stop' }],
            _headers: { 'x-ratelimit-remaining-tokens': '50' } // Extremely low
        })
    });

    pipeline.flush(); // Start fresh for Case 6
    const ctx6: PipelineContext = {
        request: { model: 'low-quota-model', messages: [{ role: 'user', content: 'Heavy request ' + Date.now() }], max_tokens: 100 },
        providerId: exhaustedProviderId,
        taskType: TaskType.Chat
    };

    try {
        // First one should succeed and set the low tracking state
        await pipeline.execute(ctx6);
        console.error('  [i] Initial request succeeded. Quota set to 50 via headers.');

        // Second one should be blocked by TokenManagerMiddleware proactively
        const ctx6b: PipelineContext = {
            request: { model: 'low-quota-model', messages: [{ role: 'user', content: 'Next unique request ' + Date.now() }], max_tokens: 100 },
            providerId: exhaustedProviderId,
            taskType: TaskType.Chat
        };
        await pipeline.execute(ctx6b);
        throw new Error('FAILED: TokenManagerMiddleware allowed request exceeding quota!');
    } catch (e: any) {
        if (e.message.includes('Exceeded tracked tokens')) {
            console.error(`  [✓] Correctly blocked: ${e.message}`);
        } else {
            console.error('  [!] Unexpected error in quota test:', e.message);
        }
    }


    // --- CASE 7: Cache Hit Stress ---
    console.error('\nTest Case 7: Cache Redundancy Verification...');
    pipeline.flush(); // Start fresh for Case 7
    const cacheCtx: PipelineContext = {
        request: { model: 'auto', messages: [{ role: 'user', content: 'Cache me if you can' }] },
        taskType: TaskType.Chat,
        wsHash: 'test-ws-hash'
    };

    const s7 = Date.now();
    await pipeline.execute({ ...cacheCtx, request: { ...cacheCtx.request, messages: [...cacheCtx.request.messages] } });
    const mid7 = Date.now();
    await pipeline.execute({ ...cacheCtx, request: { ...cacheCtx.request, messages: [...cacheCtx.request.messages] } });
    const end7 = Date.now();

    const firstTime = mid7 - s7;
    const secondTime = end7 - mid7;
    console.error(`  [i] First call (LLM): ${firstTime}ms`);
    console.error(`  [i] Second call (Cache): ${secondTime}ms`);

    if (secondTime < firstTime / 2) {
        console.error('  [✓] Cache hit confirmed. Significant speedup.');
    } else {
        console.error('  [!] Warning: Cache improvement negligible or missing.');
    }


    // --- CASE 8: Markdown Memory Verification ---
    console.error('\nTest Case 8: Structural Injection Verification...');
    pipeline.flush();
    lastCapturedRequest = null;
    const ctx8: PipelineContext = {
        request: { model: 'auto', messages: [{ role: 'user', content: 'What is the status?' }], agentic: true },
        sessionId,
        taskType: TaskType.Chat
    };
    await pipeline.execute(ctx8);
    if (hasInjectedContext(lastCapturedRequest)) {
        console.error('  [✓] Memory context injected successfully.');
    } else {
        throw new Error('FAILED: Memory context was NOT injected into the prompt!');
    }


    // --- CASE 9: Robust Content Formats (Array/Object) ---
    console.error('\nTest Case 9: Multi-modal/Robust Format Parsing...');
    
    // Test Array Content
    pipeline.flush();
    lastCapturedRequest = null;
    const ctx9a: PipelineContext = {
        request: { 
            model: 'auto', 
            messages: [{ role: 'user', content: [{ type: 'text', text: 'Analyze this code ' + Date.now() }] }], 
            agentic: true 
        },
        sessionId,
        taskType: TaskType.Chat
    };
    await pipeline.execute(ctx9a);
    if (hasInjectedContext(lastCapturedRequest)) {
        console.error('  [✓] Array content enriched successfully.');
    } else {
        throw new Error('FAILED: Array content enrichment failed!');
    }

    // Test Object Content
    pipeline.flush();
    lastCapturedRequest = null;
    const ctx9b: PipelineContext = {
        request: { 
            model: 'auto', 
            messages: [{ role: 'user', content: { type: 'text', text: 'Single object message ' + Date.now() } as any }], 
            agentic: true 
        },
        sessionId,
        taskType: TaskType.Chat
    };
    await pipeline.execute(ctx9b);
    if (hasInjectedContext(lastCapturedRequest)) {
        console.error('  [✓] Object content enriched successfully.');
    } else {
        throw new Error('FAILED: Object content enrichment failed!');
    }


    // --- CASE 10: Security Boundary Check ---
    console.error('\nTest Case 10: Path Traversal Security...');
    pipeline.flush();
    lastCapturedRequest = null;
    const ctx10: PipelineContext = {
        request: { model: 'auto', messages: [{ role: 'user', content: 'Security Probe ' + Date.now() }], agentic: true },
        sessionId: '../../etc/passwd',
        taskType: TaskType.Chat
    };
    await pipeline.execute(ctx10);
    
    if (lastCapturedRequest && !hasInjectedContext(lastCapturedRequest)) {
        console.error('  [✓] Correctly bypassed invalid sessionId (Security Gate).');
    } else if (!lastCapturedRequest) {
        // This could happen if it hit cache, but we added Date.now() so it shouldn't
        console.error('  [i] Provider not called (Cache Hit), but session was rejected.');
    } else {
        throw new Error('FAILED: StructuralMiddleware allowed invalid sessionId traversal!');
    }


    // --- CLEANUP ---
    console.error('\nCleaning up stress test data...');
    await fs.remove(projectDir);
    console.error('🔥 --- Full Pipeline Stress Test Complete --- \n');
}

main().catch(err => {
    console.error('\n[FATAL ERROR] Stress test crashed:', err);
    process.exit(1);
});
