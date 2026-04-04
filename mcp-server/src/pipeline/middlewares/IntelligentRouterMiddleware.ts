import { ProviderRegistry } from '../../providers/registry.js';
import { TaskType } from '../middleware.js';
import type { Middleware, PipelineContext, NextFunction } from '../middleware.js';
import { LLMExecutor } from '../../utils/LLMExecutor.js';
import { ContextManager } from '../../utils/ContextManager.js';

export class IntelligentRouterMiddleware implements Middleware {
    name = 'IntelligentRouterMiddleware';

    private executor: LLMExecutor;
    private contextManager: ContextManager;

    constructor(executor?: LLMExecutor) {
        this.executor = executor || new LLMExecutor();
        this.contextManager = new ContextManager();
    }

    /**
     * Clear token tracking state
     */
    flush(): void {
        this.executor.flush();
    }

    /**
     * Get token tracking state for reporting
     */
    getTokenState() {
        return this.executor.getTokenState();
    }

    /**
     * Optimized task-to-model routing map.
     */
    private taskRouteMap: Record<string, string[]> = {
        [TaskType.Coding]: [
            '@cf/qwen/qwq-32b',
            'gemini-2.5-flash',
            'qwen/qwen3-coder-480b-a35b-instruct:free',
            'mistral-large-latest',
            'DeepSeek-R1',
            'openai/gpt-oss-120b:free',
            'meta-llama/llama-3.3-70b-instruct:free',
            'gemini-3.1-pro-preview',
            'deepseek-ai/DeepSeek-R1',
            'llama-3.3-70b-versatile',
            'qwen-3-235b-a22b-instruct-2507',
            'Qwen/Qwen3-235B-A22B',
            'qwen2.5-coder-32b-instruct',
            'glm-4.5-flash',
        ],
        [TaskType.Moderation]: [
            'gemini-2.5-flash',
            '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
            'ministral-8b-latest',
            'nvidia/nemotron-3-super-120b-a12b:free',
            'nvidia/nemotron-mini-4b-instruct',
            'arcee-ai/trinity-mini:free',
            'z-ai/glm-4.5-air:free',
            'gemini-3.1-flash-lite-preview',
            'glm-4-flash',
            'glm-4.5-flash',
            'llama-3.3-70b-versatile',
            'llama3.1-8b',
            'google/gemma-2-2b-it',
            'nvidia/nemotron-nano-12b-v2-vl:free',
        ],
        [TaskType.Classification]: [
            'gemini-2.5-flash',
            '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
            'ministral-8b-latest',
            'nvidia/nemotron-3-nano-30b-a3b:free',
            'nvidia/nemotron-mini-4b-instruct',
            'arcee-ai/trinity-mini:free',
            'z-ai/glm-4.5-air:free',
            'glm-4-flash',
            'glm-4.5-flash',
            'llama-4-scout-17b-16e-instruct',
            'llama-3.3-70b-versatile',
            'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
            'llama3.1-8b',
        ],
        [TaskType.UserIntent]: [
            'gemini-2.5-flash',
            'nvidia/nemotron-mini-4b-instruct',
            'nvidia/nemotron-nano-9b-v2:free',
            'mistral-small-latest',
            '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
            'arcee-ai/trinity-mini:free',
            'z-ai/glm-4.5-air:free',
            'Llama-3.3-70B-Instruct',
            'glm-4-flash',
            'glm-4.5-flash',
            'llama-4-scout-17b-16e-instruct',
            'llama-3.3-70b-versatile',
        ],
        [TaskType.SemanticSearch]: [
            'command-r-plus-08-2024',
            'arcee-ai/trinity-large-preview:free',
            'gemini-2.5-flash',
            '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
            'mistral-large-latest',
            'qwen/qwen3-next-80b-a3b-instruct:free',
            'openai/gpt-oss-120b:free',
            'gemini-2.5-pro',
            'Qwen/Qwen3-235B-A22B',
            'llama-3.3-70b-versatile',
            'c4ai-aya-expanse-32b',
        ],
        [TaskType.Summarization]: [
            'gemini-2.5-flash',
            '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
            'command-a-03-2025',
            'mistralai/mistral-small-3.1-24b:free',
            'meta-llama/llama-3.3-70b-instruct:free',
            'openai/gpt-oss-20b:free',
            'Llama-3.3-70B-Instruct',
            'gemini-3.1-flash-preview',
            'llama-3.3-70b-versatile',
            'meta/llama-3.3-70b-instruct',
            'llama-4-scout-17b-16e-instruct',
            'qwen3.5',
        ],
        [TaskType.EntityExtraction]: [
            'gemini-2.5-flash',
            'arcee-ai/trinity-large-preview:free',
            'command-r-plus-08-2024',
            '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
            'z-ai/glm-4.5-air:free',
            'qwen/qwen3-next-80b-a3b-instruct:free',
            'gemini-3.1-flash-lite-preview',
            'Qwen/Qwen3-235B-A22B',
            'glm-4.5-flash',
            'llama-3.3-70b-versatile',
            'deepseek-ai/DeepSeek-V3',
        ],
        [TaskType.Chat]: [
            'gpt-4o',
            'gemini-2.5-flash',
            '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
            'mistral-large-latest',
            'Llama-3.3-70B-Instruct',
            'DeepSeek-R1',
            'openai/gpt-oss-120b:free',
            'meta-llama/llama-3.3-70b-instruct:free',
            'liquid/lfm2.5-1.2b-thinking:free',
            'stepfun/step-3.5-flash:free',
            'gemini-2.5-pro',
            'llama-3.3-70b-versatile',
            'deepseek-ai/DeepSeek-V3',
            'deepseek-v3.2',
            'kimi-k2.5',
            'moonshotai/kimi-k2-instruct',
            'c4ai-aya-expanse-32b',
            'glm-4.5-flash',
            'llama3.1-8b',
            'google/gemma-2-2b-it',
            'qwen-3-235b-a22b-instruct-2507',
            'Qwen/Qwen3-235B-A22B',
            'qwen2.5-coder-32b-instruct',
        ]
    };

    async execute(context: PipelineContext, next: NextFunction): Promise<void> {
        let taskType = context.taskType;
        if (!taskType || !this.taskRouteMap[taskType as string]) {
            taskType = TaskType.Chat;
            context.taskType = taskType;
        }

        // Calculate estimated tokens for context window filtering
        let estimatedTokens = this.executor.calculateTokens(context.request.messages);
        let currentMessages = [...context.request.messages];
        let contextCompressed = false;
        let lastError: Error | null = null;

        const registry = ProviderRegistry.getInstance();
        const availableProviders = registry.getAllProviders().filter(p => p.isAvailable());

        // Tracking for diagnostics
        (context as any).providersAttempted = (context as any).providersAttempted || [];

        // 1. Initial Models
        const fallbackModels = this.taskRouteMap[taskType as string] || this.taskRouteMap[TaskType.Chat];
        const tierModels = [...new Set([context.request.model, ...fallbackModels])].filter(Boolean) as string[];

        // 2. Context Overflow Guard: Check if we need to compress before attempting any providers
        const maxAvailableContext = availableProviders
            .flatMap(p => p.models)
            .reduce((max, m) => m.contextWindow ? Math.max(max, m.contextWindow) : max, 0);

        if (maxAvailableContext > 0 && estimatedTokens > maxAvailableContext) {
            // Target: leave 20% headroom
            const targetTokens = Math.floor(maxAvailableContext * 0.8) - (context.request.max_tokens || 1024);

            const summarizer = async (text: string): Promise<string> => {
                const summaryCtx: PipelineContext = {
                    request: { model: 'any', messages: [{ role: 'user', content: text }], max_tokens: 512 },
                    taskType: TaskType.Summarization,
                };

                for (const model of this.taskRouteMap[TaskType.Summarization] || []) {
                    const providers = availableProviders.filter(p => p.models.some(m => m.id === model));
                    for (const provider of providers) {
                        try {
                            summaryCtx.request.model = model;
                            const res = await this.executor.tryProvider(summaryCtx, provider.id, model);
                            return res?.choices[0]?.message?.content ?? '';
                        } catch { /* Try next */ }
                    }
                }
                throw new Error('No summarization provider');
            };

            try {
                const compressionResult = await this.contextManager.compress(context, targetTokens, summarizer);
                context.request.messages = compressionResult.messages;
                // Important: Reset token cache so it's re-calculated for the new messages
                delete context.estimatedTokens;
                estimatedTokens = this.executor.calculateTokens(context.request.messages);
                contextCompressed = true;
            } catch (err: any) {
                // console.warn(`[Router] Compression failed: ${err.message}`);
            }
        }

        // --- Main fallback loop ---
        for (const modelId of tierModels) {
            const scoredProviders = availableProviders
                .filter(p => p.models.some(m => m.id === modelId))
                .map(provider => {
                    const modelMetadata = provider.models.find(m => m.id === modelId);
                    if (modelMetadata && modelMetadata.contextWindow) {
                        if (modelMetadata.contextWindow < estimatedTokens) {
                            return { provider, score: -1 };
                        }

                        // Upscaling check: >80% window
                        if (estimatedTokens > (modelMetadata.contextWindow * 0.8)) {
                            return { provider, score: -1 };
                        }
                    }

                    // Deprioritize free Cloudflare for large workloads
                    if (estimatedTokens > 3000 && provider.id === 'cloudflare') {
                        return { provider, score: -1 };
                    }

                    const usage = (provider as any).getUsageStats?.() || { requestCountMinute: 0 };
                    const rpmLimit = provider.rateLimits.rpm || 60;
                    const rateLimitScore = 1 - (usage.requestCountMinute / rpmLimit);
                    const tokenScore = this.executor.getTokenScore(provider.id);

                    return { provider, score: Math.max(0, rateLimitScore * tokenScore) };
                })
                .filter(p => p.score >= 0)
                .sort((a, b) => b.score - a.score);

            for (const { provider } of scoredProviders) {
                try {
                    (context as any).providersAttempted.push(`${provider.id}/${modelId}`);
                    const response = await this.executor.tryProvider(context, provider.id, modelId);
                    if (response) {
                        if (contextCompressed) (context as any).contextCompressed = true;
                        context.response = response;
                        context.providerId = provider.id;
                        context.request.model = modelId;
                        await next();
                        return;
                    }
                } catch (err: any) {
                    lastError = err;
                    // console.warn(`[Router] Provider ${provider.id} failed for model ${modelId}: ${err.message}. Cascading...`);
                    continue;
                }
            }
        }

        // --- Deep Compression Emergency Fallback ---
        const emergencyModels = ['gemini-2.5-flash', 'command-r-plus-08-2024', 'llama-3.3-70b-versatile', 'gpt-4o', 'mistral-large-latest'];
        const emergencyTarget = 1500;

        const compressionResult = this.contextManager.truncateOldest(currentMessages, emergencyTarget);
        context.request.messages = compressionResult.messages;
        // Important: Reset token cache!
        delete context.estimatedTokens;
        contextCompressed = true;

        for (const modelId of emergencyModels) {
            const scoredProviders = availableProviders
                .filter(p => p.models.some(m => m.id === modelId))
                .map(provider => ({ provider, score: this.executor.getTokenScore(provider.id) }))
                .filter(p => p.score >= 0)
                .sort((a, b) => b.score - a.score);

            for (const { provider } of scoredProviders) {
                try {
                    (context as any).providersAttempted.push(`EMERGENCY:${provider.id}/${modelId}`);
                    const response = await this.executor.tryProvider(context, provider.id, modelId);
                    if (response) {
                        (context as any).contextCompressed = true;
                        context.response = response;
                        context.providerId = provider.id;
                        context.request.model = modelId;
                        await next();
                        return;
                    }
                } catch (err: any) {
                    lastError = err;
                    continue;
                }
            }
        }

        throw new Error(
            `[Router] Exhausted all fallback models and compression for task ${taskType}. ` +
            `Last error: ${lastError?.message || 'No available providers'}`
        );
    }
}
